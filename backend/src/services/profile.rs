//! The column profile: what one column holds under the grid's filter, for
//! the panel that opens beside the grid — the row count, how many are
//! NULL, how many distinct values there are, and a chart of the values.
//!
//! Everything is a query over a `ProfileSource` — a file's shared session,
//! so the filter goes through the same read-only check the grid's does, or
//! the rows a SQL query returned — with the grid's `WHERE` fragment
//! applied, so the panel describes the rows the grid shows. Two or three
//! queries per profile: the counts, then the chart's own — and the
//! histogram's range before its buckets.
//!
//! The counts and the chart are asked for separately (`counts`, `chart`),
//! because only the first of those scans is quick: on 58M rows the counts
//! answer in half a second to four, while the chart of a column with a
//! distinct value per row takes twenty. The panel shows what it has. Which
//! chart a column gets follows from the counts, so they are the argument to
//! `chart` rather than something it reads again.
//!
//! Which chart a column gets is decided here from the distinct count, not
//! from the type alone: a column with at most `TOP_VALUES` distinct values
//! is listed in full whatever its type (a status code, a boolean, a year),
//! and past that numbers and dates are binned into equal-width buckets while
//! text and binary keep their `TOP_VALUES` commonest values with the rest
//! counted as `other`. Integers outside the safe double range, decimals with
//! more than fifteen digits of precision and unrepresentable bucket edges
//! also use top values, keeping drill-down literals exact.
//!
//! The session runs single-partition (see `ParquetCache::get_or_create_session`),
//! so every query here is a single-threaded scan; the webview only asks
//! when the panel is open, never on opening a file.
//!
//! What a profile costs is the counts query, and inside it the
//! `COUNT(DISTINCT)`: on 58M rows a low-cardinality column answers in about a
//! second and holds 40 MB, while one distinct value per row takes two to three
//! seconds and 1.2 GB — and a text column of 58M distinct values cannot be
//! counted exactly at all, because the distinct aggregate cannot spill and
//! exhausts the session's 2 GiB pool after about 1.9 GB (the process had
//! 4.3 GB resident by then: the pool tracks less than arrow actually holds).
//! That column is estimated instead (`approx_distinct`, a sketch of a fixed
//! size) and the answer says the number is an estimate, so the panel can
//! print it as one.
//! That reservation is also why a superseded profile is cancelled rather
//! than merely ignored (`services::profile_requests`): while nothing stopped
//! the abandoned scan, clicking along four columns of that file ended with
//! the profile the user was waiting for refused and the one they had left
//! behind finishing. A profile that is merely slow does not disturb the grid
//! — a page read beside one stays within a few milliseconds of its own time,
//! a deep sorted page within 2% — so what not cancelling cost was the next
//! profile, not the rows. `scripts/qa/PERFORMANCE.md` has the measurement and
//! what was decided from it (#30).

use arrow::array::{Array, Int64Array};
use arrow::datatypes::{DataType, TimeUnit};
use arrow::record_batch::RecordBatch;
use serde_json::Value;

use arrow::datatypes::SchemaRef;
use datafusion::prelude::SessionContext;

use crate::models::{ColumnCounts, ColumnKind, HistogramBucket, ProfileChart, ValueCount};
use crate::services::parquet::{
    batches_to_rows, execute_sql_with_cache, is_memory_exhausted, quote_identifier, where_clause,
    ParquetCache,
};

/// What a profile aggregates over. Both answer SQL against a table called
/// `t`, which is the only thing the queries below assume: a file goes
/// through its cached session, a kept query result through a `MemTable`
/// of the rows the webview was given.
pub enum ProfileSource<'a> {
    File { cache: &'a ParquetCache, path: &'a str },
    /// A session with a kept result registered as `t`
    /// (`services::query_results`). The SQL run against it is this
    /// module's own, never the user's, so it needs no read-only check.
    Result(&'a SessionContext),
}

impl ProfileSource<'_> {
    async fn query(&self, sql: &str) -> Result<(Vec<RecordBatch>, SchemaRef), String> {
        match self {
            Self::File { cache, path } => execute_sql_with_cache(cache, path, sql).await,
            Self::Result(ctx) => {
                let df = ctx
                    .sql(sql)
                    .await
                    .map_err(|e| format!("Failed to read the result: {e}"))?;
                let schema = df.schema().inner().clone();
                let batches = df
                    .collect()
                    .await
                    .map_err(|e| format!("Failed to read the result: {e}"))?;
                Ok((batches, schema))
            }
        }
    }
}

/// How many values a `TopValues` chart lists, and the most distinct values
/// a column may have and still be listed in full. Twenty rows fit the panel
/// without scrolling past the counts above them.
pub const TOP_VALUES: usize = 20;

/// How many buckets a histogram aims for. The widths are rounded to 1, 2 or
/// 5 times a power of ten (whole days for dates, whole seconds for times),
/// so the actual count lands between half of this and one more.
pub const HISTOGRAM_BUCKETS: usize = 20;

/// ` WHERE a AND b`, with the user's filter parenthesized: it is a fragment
/// the filter bar joined with AND, but a session restored from an older
/// build, or a hand-edited one, could carry an OR.
fn where_sql(filter: Option<&str>, conditions: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(f) = filter {
        parts.push(format!("({})", f));
    }
    parts.extend(conditions.iter().cloned());
    if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(" AND "))
    }
}

/// The `i64` in column `index` of the first non-empty batch's first row —
/// what a `COUNT` answers with; an empty result reads as 0.
fn i64_cell(batches: &[RecordBatch], index: usize) -> Result<i64, String> {
    let Some(batch) = batches.iter().find(|b| b.num_rows() > 0) else {
        return Ok(0);
    };
    let column = batch
        .column(index)
        .as_any()
        .downcast_ref::<Int64Array>()
        .ok_or_else(|| "Failed to read a count from the query result".to_string())?;
    Ok(if column.is_null(0) { 0 } else { column.value(0) })
}

fn count_cell(batches: &[RecordBatch], index: usize) -> Result<usize, String> {
    let n = i64_cell(batches, index)?;
    usize::try_from(n).map_err(|_| format!("Invalid count: {}", n))
}

/// A count read back out of `batches_to_rows` (JSON), for the chart queries.
fn count_of(row: &Value, key: &str) -> Result<usize, String> {
    row.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| format!("The profile query returned no {} column", key))
}

/// A result column's kind, from the type DataFusion planned for it. The
/// file's own kinds are read from the parquet schema (`column_kind`),
/// which a query result does not have: an expression's type is decided by
/// the plan, and a CAST changes it.
///
/// A dictionary column is `Other` — counts, no chart. Its values would
/// reach the panel through the same JSON rendering the SQL view already
/// declines to trust for a dictionary (see `chart_type_of`), and a chart
/// of values is exactly what that would show.
pub fn column_kind_of(data_type: &DataType) -> ColumnKind {
    match data_type {
        DataType::Boolean => ColumnKind::Boolean,
        DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64
        | DataType::UInt8 | DataType::UInt16 | DataType::UInt32 | DataType::UInt64 => ColumnKind::Integer,
        DataType::Float16 | DataType::Float32 | DataType::Float64 => ColumnKind::Float,
        DataType::Decimal32(_, _) | DataType::Decimal64(_, _)
        | DataType::Decimal128(_, _) | DataType::Decimal256(_, _) => ColumnKind::Decimal,
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => ColumnKind::Text,
        DataType::Date32 | DataType::Date64 | DataType::Time32(_) | DataType::Time64(_)
        | DataType::Timestamp(_, _) => ColumnKind::Temporal,
        DataType::Binary | DataType::LargeBinary | DataType::BinaryView
        | DataType::FixedSizeBinary(_) => ColumnKind::Binary,
        DataType::List(_) | DataType::LargeList(_) | DataType::ListView(_)
        | DataType::LargeListView(_) | DataType::FixedSizeList(_, _)
        | DataType::Struct(_) | DataType::Map(_, _) | DataType::Union(_, _) => ColumnKind::Nested,
        _ => ColumnKind::Other,
    }
}

/// The counts of `column` in the file at `path`, over the rows `filter`
/// keeps: the first of the two calls a panel makes.
pub async fn column_counts(
    cache: &ParquetCache,
    path: &str,
    column: &str,
    filter: Option<String>,
) -> Result<ColumnCounts, String> {
    cache.check_unchanged(path)?;
    let kind = file_column_kind(cache, path, column).await?;
    let source = ProfileSource::File { cache, path };
    counts(&source, column, &quote_identifier(column), kind, filter).await
}

/// The chart of `column` in the file at `path`, over the same rows. Which
/// chart it is was decided by `counts`, so they come back in.
pub async fn column_chart(
    cache: &ParquetCache,
    path: &str,
    column: &str,
    filter: Option<String>,
    counted: &ColumnCounts,
) -> Result<ProfileChart, String> {
    cache.check_unchanged(path)?;
    let kind = file_column_kind(cache, path, column).await?;
    let source = ProfileSource::File { cache, path };
    chart(&source, &quote_identifier(column), kind, filter, counted).await
}

/// A file column's kind, from the cached schema.
async fn file_column_kind(
    cache: &ParquetCache,
    path: &str,
    column: &str,
) -> Result<ColumnKind, String> {
    let metadata = cache.get_or_create_metadata(path).await?;
    metadata
        .columns
        .iter()
        .find(|c| c.name == column)
        .map(|c| c.kind)
        .ok_or_else(|| format!("This file has no column named \"{}\"", column))
}

/// Count the column `col` names in `source`, calling it `name` in the
/// answer. `col` is already an expression the SQL can use — a quoted file
/// column, or a result's positional alias — because what a column is
/// called and how it is addressed are not the same thing once a query
/// result is in play.
pub async fn counts(
    source: &ProfileSource<'_>,
    name: &str,
    col: &str,
    kind: ColumnKind,
    filter: Option<String>,
) -> Result<ColumnCounts, String> {
    let filter = where_clause(filter.as_deref()).map(str::to_string);
    let filter = filter.as_deref();

    // COUNT(DISTINCT) is not defined on a list or a struct, and an
    // interval's ordering is not one a chart could use either.
    let countable = !matches!(kind, ColumnKind::Nested | ColumnKind::Other);
    let query = |distinct: Option<&str>| {
        let third = distinct.map(|d| format!(", {d}")).unwrap_or_default();
        format!("SELECT COUNT(*), COUNT({col}){third} FROM t{}", where_sql(filter, &[]))
    };
    let (batches, distinct_approximate) = if countable {
        match source.query(&query(Some(&format!("COUNT(DISTINCT {col})")))).await {
            Ok((batches, _)) => (batches, false),
            // An exact count keeps every distinct value in a hash set that
            // cannot spill, so a column with tens of millions of them asks
            // for more than the session's pool holds. An estimate is a
            // sketch of a fixed size: it answers where the exact count gives
            // up, and the panel prints it as an estimate. Anything else that
            // could fail here — a filter that does not parse, a column the
            // query cannot resolve — fails the estimate too, and the first
            // error is the one that says what is wrong.
            Err(exhausted) if is_memory_exhausted(&exhausted) => {
                // Cast because the sketch counts in `UInt64` while every
                // other count here arrives as `Int64`, and the cell is read
                // by type.
                match source
                    .query(&query(Some(&format!("CAST(approx_distinct({col}) AS BIGINT)"))))
                    .await
                {
                    Ok((batches, _)) => (batches, true),
                    Err(_) => return Err(exhausted),
                }
            }
            Err(other) => return Err(other),
        }
    } else {
        (source.query(&query(None)).await?.0, false)
    };
    let total_rows = count_cell(&batches, 0)?;
    let non_null = count_cell(&batches, 1)?;

    Ok(ColumnCounts {
        column: name.to_string(),
        kind,
        total_rows,
        null_count: total_rows.saturating_sub(non_null),
        distinct_count: if countable { Some(count_cell(&batches, 2)?) } else { None },
        distinct_approximate,
    })
}

/// The chart for the column `counted` describes: which one it is follows
/// from the distinct count, not from the type alone, so the counts are the
/// argument rather than something this re-reads.
pub async fn chart(
    source: &ProfileSource<'_>,
    col: &str,
    kind: ColumnKind,
    filter: Option<String>,
    counted: &ColumnCounts,
) -> Result<ProfileChart, String> {
    let filter = where_clause(filter.as_deref()).map(str::to_string);
    let filter = filter.as_deref();
    let non_null = counted.total_rows.saturating_sub(counted.null_count);

    Ok(match counted.distinct_count {
        None => ProfileChart::Unsupported,
        // An estimate never takes the branch that lists every value: the
        // list would claim to be complete on a count that is not exact.
        Some(distinct) if distinct <= TOP_VALUES && !counted.distinct_approximate => {
            top_values(source, col, filter, non_null).await?
        }
        Some(_) if matches!(
            kind,
            ColumnKind::Integer | ColumnKind::Float | ColumnKind::Decimal | ColumnKind::Temporal
        ) =>
        {
            histogram(source, col, kind, filter, non_null).await?
        }
        Some(_) => top_values(source, col, filter, non_null).await?,
    })
}

/// The `TOP_VALUES` commonest non-null values. Ties are broken by the value
/// itself so the list is the same on every run.
async fn top_values(
    source: &ProfileSource<'_>,
    col: &str,
    filter: Option<&str>,
    non_null: usize,
) -> Result<ProfileChart, String> {
    let query = format!(
        "SELECT {col} AS \"value\", COUNT(*) AS \"n\" FROM t{} GROUP BY {col} ORDER BY \"n\" DESC, \"value\" ASC LIMIT {}",
        where_sql(filter, &[format!("{col} IS NOT NULL")]),
        TOP_VALUES
    );
    let (batches, _) = source.query(&query).await?;
    let values = batches_to_rows(&batches)?
        .into_iter()
        .map(|mut row| {
            let count = count_of(&row, "n")?;
            let value = row
                .get_mut("value")
                .map(Value::take)
                .ok_or_else(|| "The profile query returned no value column".to_string())?;
            Ok(ValueCount { value, count })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let listed: usize = values.iter().map(|v| v.count).sum();
    Ok(ProfileChart::TopValues { values, other: non_null.saturating_sub(listed) })
}

/// What the histogram bins: a number as a double, or a temporal value by its
/// raw count of units (days, or a time unit) so bucket edges can be whole
/// days / seconds and labelled in the column's own type.
enum Axis {
    Number,
    Temporal(DataType),
}

/// The raw units per bucket-edge granularity: one day for dates, one
/// second for times and timestamps, so edges are labelled without a time
/// of day / fractional seconds and compare as typed.
fn granularity(data_type: &DataType) -> i64 {
    let per_second = |unit: &TimeUnit| match unit {
        TimeUnit::Second => 1,
        TimeUnit::Millisecond => 1_000,
        TimeUnit::Microsecond => 1_000_000,
        TimeUnit::Nanosecond => 1_000_000_000,
    };
    match data_type {
        DataType::Date32 => 1,
        DataType::Date64 => 86_400_000,
        DataType::Time32(unit) | DataType::Time64(unit) | DataType::Timestamp(unit, _) => per_second(unit),
        _ => 1,
    }
}

/// The smallest of 1, 2, 5 × 10ⁿ that is at least `x` (x > 0): the bucket
/// widths a reader can add up in their head.
fn nice_ceil(x: f64) -> f64 {
    let magnitude = 10f64.powi(x.log10().floor() as i32);
    let fraction = x / magnitude;
    let nice = if fraction <= 1.0 {
        1.0
    } else if fraction <= 2.0 {
        2.0
    } else if fraction <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * magnitude
}

/// A bucket edge as the literal a filter compares the column with: a
/// number rounded to the width's own precision (so `0.1 × 3` does not print
/// as `0.30000000000000004`), or a temporal value in arrow's rendering.
fn edge_label(axis: &Axis, edge: f64, width: f64) -> Result<String, String> {
    match axis {
        Axis::Number => {
            let decimals = (-width.log10().floor()).max(0.0) as i32;
            let scale = 10f64.powi(decimals);
            let scaled = edge * scale;
            if !scale.is_finite() || !scaled.is_finite() {
                return Err("Bucket label exceeds floating-point precision".into());
            }
            Ok((scaled.round() / scale).to_string())
        }
        Axis::Temporal(data_type) => {
            let raw = Int64Array::from(vec![edge as i64]);
            let through = match data_type {
                DataType::Date32 | DataType::Time32(_) => DataType::Int32,
                _ => DataType::Int64,
            };
            let narrowed = arrow::compute::cast(&raw, &through).map_err(|e| e.to_string())?;
            let typed = arrow::compute::cast(&narrowed, data_type).map_err(|e| e.to_string())?;
            let label = arrow::util::display::array_value_to_string(&typed, 0)
                .map_err(|e| e.to_string())?;
            // Arrow's display formatter can return an error *as text*.
            if label.starts_with("ERROR:") || label.is_empty() {
                return Err("Bucket edge is outside the temporal type's range".into());
            }
            Ok(label)
        }
    }
}

/// Equal-width buckets over `[min, max]`, each `width` wide, with the first
/// one starting on a multiple of the width so the edges are round. Pure;
/// the counts are filled in by the query.
fn bucket_edges(min: f64, max: f64, width: f64) -> Vec<(f64, f64)> {
    let first = (min / width).floor() * width;
    // At most HISTOGRAM_BUCKETS + 1 by construction; the cap only guards
    // against a floating-point surprise producing an endless loop.
    let count = (((max - first) / width).floor() as usize + 1).min(HISTOGRAM_BUCKETS + 2);
    (0..count)
        .map(|i| (first + i as f64 * width, first + (i + 1) as f64 * width))
        .collect()
}

/// The bucket width for a range: a nice number of the axis's granularity,
/// and never less than one of it — a histogram over dates is never finer
/// than a day, over integers never finer than one.
fn bucket_width(axis: &Axis, kind: ColumnKind, range: f64) -> f64 {
    let unit = match axis {
        Axis::Number if kind == ColumnKind::Integer => 1.0,
        Axis::Number => 0.0,
        Axis::Temporal(data_type) => granularity(data_type) as f64,
    };
    let target = range / HISTOGRAM_BUCKETS as f64;
    if unit > 0.0 {
        nice_ceil((target / unit).max(1.0)) * unit
    } else if target > 0.0 {
        nice_ceil(target)
    } else {
        1.0
    }
}

async fn histogram(
    source: &ProfileSource<'_>,
    col: &str,
    kind: ColumnKind,
    filter: Option<&str>,
    non_null: usize,
) -> Result<ProfileChart, String> {
    let mut conditions = vec![format!("{col} IS NOT NULL")];
    if kind == ColumnKind::Float {
        // NaN and the infinities have no place on the axis. `x - x` is 0 for
        // every finite value and NaN for the rest. NaN is unequal to zero
        // under either IEEE or total ordering, so this works without relying
        // on how the comparison kernels order NaN.
        let x = format!("CAST({col} AS DOUBLE)");
        conditions.push(format!("({x} - {x}) = 0"));
    }

    // The range, read in the column's own type so a temporal column can be
    // told apart from a number and labelled as itself.
    let range_query = format!(
        "SELECT MIN({col}), MAX({col}) FROM t{}",
        where_sql(filter, &conditions)
    );
    let (batches, schema) = source.query(&range_query).await?;
    let data_type = schema.field(0).data_type().clone();
    // A double cannot safely choose decimal boundaries at arbitrary precision.
    // Keep exact rendered values for those columns instead of fabricating bins.
    if matches!(&data_type, DataType::Decimal128(precision, _) | DataType::Decimal256(precision, _) if *precision > 15) {
        return top_values(source, col, filter, non_null).await;
    }
    let axis = if kind == ColumnKind::Temporal { Axis::Temporal(data_type) } else { Axis::Number };
    let Some(batch) = batches.iter().find(|b| b.num_rows() > 0) else {
        return Ok(ProfileChart::Histogram { buckets: Vec::new(), other: non_null });
    };
    if batch.column(0).is_null(0) || batch.column(1).is_null(0) {
        return Ok(ProfileChart::Histogram { buckets: Vec::new(), other: non_null });
    }
    let as_f64 = |index: usize| -> Result<f64, String> {
        let through = match &axis {
            Axis::Number => DataType::Float64,
            Axis::Temporal(DataType::Date32 | DataType::Time32(_)) => DataType::Int32,
            Axis::Temporal(_) => DataType::Int64,
        };
        let narrowed = arrow::compute::cast(batch.column(index), &through).map_err(|e| e.to_string())?;
        let wide = arrow::compute::cast(&narrowed, &DataType::Float64).map_err(|e| e.to_string())?;
        let values = wide
            .as_any()
            .downcast_ref::<arrow::array::Float64Array>()
            .ok_or_else(|| "Failed to read the column's range".to_string())?;
        Ok(values.value(0))
    };
    let (min, max) = (as_f64(0)?, as_f64(1)?);

    let range = max - min;
    // A finite input can still overflow subtraction, or lose all low bits
    // when an integer becomes a double. In either case top values preserve
    // the original literals and remain useful for drilling down.
    let safe_integer = 9_007_199_254_740_991.0;
    if !range.is_finite()
        || (matches!(kind, ColumnKind::Integer | ColumnKind::Decimal)
            && (min.abs() > safe_integer || max.abs() > safe_integer))
    {
        return top_values(source, col, filter, non_null).await;
    }
    let width = bucket_width(&axis, kind, range);
    if !width.is_finite() || width <= 0.0 || !(min / width).is_finite() {
        return top_values(source, col, filter, non_null).await;
    }
    let edges = bucket_edges(min, max, width);
    if edges.iter().any(|(lo, hi)| !lo.is_finite() || !hi.is_finite() || lo >= hi)
        || edges[0].0 > min || edges.last().unwrap().1 <= max
    {
        return top_values(source, col, filter, non_null).await;
    }

    let day_end = match &axis {
        Axis::Temporal(data_type @ (DataType::Time32(_) | DataType::Time64(_))) =>
            Some(86_400 * granularity(data_type)),
        _ => None,
    };
    let labelled = edges.iter().map(|(lower, upper)| {
        // 24:00 is not an Arrow time value. Use the last representable
        // instant of the day with <=, including subsecond values at its end.
        let upper_inclusive = day_end.is_some_and(|end| *upper >= end as f64);
        let upper = if upper_inclusive { (day_end.unwrap() - 1) as f64 } else { *upper };
        Ok(HistogramBucket {
            lower: edge_label(&axis, *lower, width)?,
            upper: edge_label(&axis, upper, width)?,
            upper_inclusive,
            count: 0,
        })
    }).collect::<Result<Vec<_>, String>>();
    let Ok(mut buckets) = labelled else {
        return top_values(source, col, filter, non_null).await;
    };
    if buckets.iter().any(|b| b.lower == b.upper && !b.upper_inclusive) {
        return top_values(source, col, filter, non_null).await;
    }

    // Count with exactly the predicates the filter bar submits, on the
    // original column type. FLOOR on doubles could disagree with the
    // displayed labels, especially for decimals or adjacent float values.
    let literal = |label: &str| match axis {
        Axis::Number => label.to_string(),
        Axis::Temporal(_) => format!("'{}'", label.replace('\'', "''")),
    };
    let aggregates = buckets.iter().map(|b| {
        let op = if b.upper_inclusive { "<=" } else { "<" };
        format!("COUNT(*) FILTER (WHERE {col} >= {} AND {col} {op} {})",
            literal(&b.lower), literal(&b.upper))
    }).collect::<Vec<_>>().join(", ");
    let query = format!("SELECT {aggregates} FROM t{}", where_sql(filter, &conditions));
    let (batches, _) = source.query(&query).await?;
    for (index, bucket) in buckets.iter_mut().enumerate() {
        bucket.count = count_cell(&batches, index)?;
    }

    let binned: usize = buckets.iter().map(|b| b.count).sum();
    Ok(ProfileChart::Histogram { buckets, other: non_null.saturating_sub(binned) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::test_support::{self, write_parquet};
    use arrow::array::{
        ArrayRef, BooleanArray, Date32Array, Float64Array, Int32Builder, Int64Array, ListBuilder,
        StringArray, TimestampMicrosecondArray,
    };
    use arrow::datatypes::{Field, Schema};
    use std::path::PathBuf;
    use std::sync::Arc;

    fn fixture(name: &str, columns: Vec<(&str, ArrayRef)>) -> String {
        let fields: Vec<Field> = columns
            .iter()
            .map(|(name, array)| Field::new(*name, array.data_type().clone(), true))
            .collect();
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(fields)),
            columns.into_iter().map(|(_, a)| a).collect(),
        )
        .unwrap();
        let path: PathBuf = test_support::temp_path("profile", name);
        write_parquet(&path, &batch, None);
        path.to_string_lossy().into_owned()
    }

    /// The two calls a panel makes, assembled: the assertions below are
    /// about one column's profile, which is what the pair adds up to.
    struct Profiled {
        column: String,
        kind: ColumnKind,
        total_rows: usize,
        null_count: usize,
        distinct_count: Option<usize>,
        distinct_approximate: bool,
        chart: ProfileChart,
    }

    async fn profile(path: &str, column: &str, filter: Option<&str>) -> Profiled {
        profile_with(&ParquetCache::new(), path, column, filter)
            .await
            .unwrap_or_else(|e| panic!("{column}: {e}"))
    }

    async fn profile_with(
        cache: &ParquetCache,
        path: &str,
        column: &str,
        filter: Option<&str>,
    ) -> Result<Profiled, String> {
        let filter = filter.map(str::to_string);
        let counted = column_counts(cache, path, column, filter.clone()).await?;
        let chart = column_chart(cache, path, column, filter, &counted).await?;
        Ok(Profiled {
            column: counted.column,
            kind: counted.kind,
            total_rows: counted.total_rows,
            null_count: counted.null_count,
            distinct_count: counted.distinct_count,
            distinct_approximate: counted.distinct_approximate,
            chart,
        })
    }

    fn top_values(chart: &ProfileChart) -> (Vec<(Value, usize)>, usize) {
        match chart {
            ProfileChart::TopValues { values, other } => (
                values.iter().map(|v| (v.value.clone(), v.count)).collect(),
                *other,
            ),
            other => panic!("expected top values, got {other:?}"),
        }
    }

    fn histogram(chart: &ProfileChart) -> (Vec<(String, String, usize)>, usize) {
        match chart {
            ProfileChart::Histogram { buckets, other } => (
                buckets.iter().map(|b| (b.lower.clone(), b.upper.clone(), b.count)).collect(),
                *other,
            ),
            other => panic!("expected a histogram, got {other:?}"),
        }
    }

    /// The exact distinct count is a hash set of every value and cannot
    /// spill, so a wide enough column asks for more than the session's pool
    /// holds. The profile answers with an estimate rather than the error
    /// DataFusion raises, and says that is what it is.
    #[tokio::test]
    async fn a_distinct_count_past_the_memory_pool_is_estimated_and_says_so() {
        let values: Vec<String> = (0..200_000).map(|n| format!("value-{n:018}")).collect();
        let path = fixture(
            "wide_distinct.parquet",
            vec![(
                "token",
                Arc::new(StringArray::from(values.iter().map(String::as_str).collect::<Vec<_>>())) as ArrayRef,
            )],
        );

        let exact = profile_with(&ParquetCache::new(), &path, "token", None).await.unwrap();
        assert_eq!(exact.distinct_count, Some(200_000));
        assert!(!exact.distinct_approximate, "an exact count that fits is not an estimate");

        // 16 MiB is between the two aggregates this column needs: the
        // exact count keeps a `ScalarValue` per distinct value and wants
        // more, while the chart's group-by holds the same values in its
        // compact row format and fits with room for the top-k above it. A
        // bigger pool would count exactly and never reach the estimate.
        let cramped = ParquetCache::new().with_memory_limit(16 * 1024 * 1024);
        let estimated = profile_with(&cramped, &path, "token", None).await.unwrap();
        assert!(estimated.distinct_approximate, "the count that did not fit is not marked as an estimate");
        let estimate = estimated.distinct_count.expect("an estimate, not nothing");
        // A sketch, not a count: near the truth and never sold as exact.
        assert!(
            (180_000..=220_000).contains(&estimate),
            "estimate {estimate} is not within 10% of 200,000"
        );
        assert_eq!(estimated.total_rows, 200_000);
        assert_eq!(estimated.null_count, 0);
        // Twenty values out of forty thousand: the estimate cannot turn the
        // chart into a list that claims to be complete.
        let (values, other) = top_values(&estimated.chart);
        assert_eq!(values.len(), TOP_VALUES);
        assert_eq!(other, 200_000 - TOP_VALUES);
    }

    #[tokio::test]
    async fn a_text_column_lists_every_value_commonest_first_and_counts_nulls() {
        let path = fixture(
            "text.parquet",
            vec![
                ("cat", Arc::new(StringArray::from(vec![Some("a"), Some("b"), Some("a"), None, Some("c")]))),
                ("n", Arc::new(Int64Array::from(vec![1, 2, 3, 4, 5]))),
            ],
        );
        let p = profile(&path, "cat", None).await;
        assert_eq!((p.total_rows, p.null_count, p.distinct_count), (5, 1, Some(3)));
        assert_eq!(p.kind, ColumnKind::Text);
        assert_eq!(
            top_values(&p.chart),
            (vec![(Value::from("a"), 2), (Value::from("b"), 1), (Value::from("c"), 1)], 0)
        );

        // The grid's filter narrows the profile the same way it narrows the grid.
        let p = profile(&path, "cat", Some("\"n\" > 2")).await;
        assert_eq!((p.total_rows, p.null_count), (3, 1));
        assert_eq!(top_values(&p.chart).0, vec![(Value::from("a"), 1), (Value::from("c"), 1)]);

        // A blank filter is no filter.
        assert_eq!(profile(&path, "cat", Some("  ")).await.total_rows, 5);
    }

    #[tokio::test]
    async fn booleans_and_small_integers_are_listed_in_full() {
        let path = fixture(
            "small.parquet",
            vec![
                ("flag", Arc::new(BooleanArray::from(vec![Some(true), Some(false), Some(true), None]))),
                ("code", Arc::new(Int64Array::from(vec![Some(200), Some(404), Some(200), Some(200)]))),
            ],
        );
        let p = profile(&path, "flag", None).await;
        assert_eq!(top_values(&p.chart), (vec![(Value::from(true), 2), (Value::from(false), 1)], 0));
        let p = profile(&path, "code", None).await;
        assert_eq!(p.distinct_count, Some(2));
        assert_eq!(top_values(&p.chart), (vec![(Value::from(200), 3), (Value::from(404), 1)], 0));
    }

    #[tokio::test]
    async fn text_past_the_limit_keeps_the_commonest_and_counts_the_rest() {
        // 25 distinct names, one of them twice: 26 non-null rows.
        let mut names: Vec<Option<String>> = (0..25).map(|i| Some(format!("name-{i:02}"))).collect();
        names.push(Some("name-07".to_string()));
        names.push(None);
        let path = fixture("many_text.parquet", vec![("name", Arc::new(StringArray::from(names)))]);
        let p = profile(&path, "name", None).await;
        assert_eq!(p.distinct_count, Some(25));
        let (values, other) = top_values(&p.chart);
        assert_eq!(values.len(), TOP_VALUES);
        assert_eq!(values[0], (Value::from("name-07"), 2));
        // The 20 listed values cover 21 rows of the 26.
        assert_eq!(other, 5);
    }

    #[tokio::test]
    async fn integers_past_the_limit_are_binned_on_round_edges() {
        let path = fixture(
            "ints.parquet",
            vec![("id", Arc::new(Int64Array::from((0..100).collect::<Vec<i64>>())))],
        );
        let p = profile(&path, "id", None).await;
        assert_eq!(p.distinct_count, Some(100));
        let (buckets, other) = histogram(&p.chart);
        // range 99 / 20 = 4.95 -> width 5, twenty buckets of five.
        assert_eq!(buckets.len(), 20);
        assert_eq!(buckets[0], ("0".into(), "5".into(), 5));
        assert_eq!(buckets[19], ("95".into(), "100".into(), 5));
        assert!(buckets.iter().all(|b| b.2 == 5), "{buckets:?}");
        assert_eq!(other, 0);

        // Under a filter the bins follow the narrower range.
        let p = profile(&path, "id", Some("\"id\" < 30")).await;
        let (buckets, _) = histogram(&p.chart);
        // range 29 / 20 = 1.45 -> width 2, fifteen buckets.
        assert_eq!(buckets.len(), 15);
        assert_eq!(buckets[0], ("0".into(), "2".into(), 2));
    }

    #[tokio::test]
    async fn non_finite_floats_are_counted_but_not_binned() {
        let mut xs: Vec<Option<f64>> = (0..25).map(|i| Some(i as f64 * 0.1)).collect();
        xs.extend([Some(f64::NAN), Some(f64::INFINITY), Some(f64::NEG_INFINITY), None]);
        let path = fixture("floats.parquet", vec![("x", Arc::new(Float64Array::from(xs)))]);
        let p = profile(&path, "x", None).await;
        assert_eq!((p.total_rows, p.null_count, p.distinct_count), (29, 1, Some(28)));
        let (buckets, other) = histogram(&p.chart);
        assert_eq!(other, 3, "{buckets:?}");
        assert_eq!(buckets.iter().map(|b| b.2).sum::<usize>(), 25);
        // range 2.4 / 20 = 0.12 -> width 0.2; edges printed at that precision.
        assert_eq!(buckets[0].0, "0");
        assert_eq!(buckets[0].1, "0.2");
        assert_eq!(buckets[1], ("0.2".into(), "0.4".into(), 2));
        assert!(buckets.iter().all(|b| !b.0.contains("00000")), "{buckets:?}");
    }

    #[tokio::test]
    async fn dates_are_binned_by_whole_days_and_labelled_as_dates() {
        // 2024-01-01 is day 19723; sixty consecutive days.
        let days: Vec<i32> = (0..60).map(|i| 19723 + i).collect();
        let path = fixture("dates.parquet", vec![("d", Arc::new(Date32Array::from(days)))]);
        let p = profile(&path, "d", None).await;
        assert_eq!(p.kind, ColumnKind::Temporal);
        let (buckets, other) = histogram(&p.chart);
        assert_eq!(other, 0);
        assert_eq!(buckets.iter().map(|b| b.2).sum::<usize>(), 60);
        // range 59 / 20 = 2.95 -> five days; 19723 rounds down to 19720 = 2023-12-29.
        assert_eq!(buckets[0].0, "2023-12-29");
        assert_eq!(buckets[0].1, "2024-01-03");
        assert_eq!(buckets[0].2, 2, "{buckets:?}");
        for pair in buckets.windows(2) {
            assert_eq!(pair[0].1, pair[1].0, "buckets are contiguous");
        }
        // The labels compare as typed: the first bucket's edges select its rows.
        let p = profile(&path, "d", Some("\"d\" >= '2023-12-29' AND \"d\" < '2024-01-03'")).await;
        assert_eq!(p.total_rows, 2);
    }

    #[tokio::test]
    async fn timestamps_are_binned_by_whole_seconds() {
        // Thirty values a minute apart from 2024-01-02T03:04:05.678901.
        let base = 1_704_164_645_678_901i64;
        let ts: Vec<i64> = (0..30).map(|i| base + i * 60_000_000).collect();
        let path = fixture("ts.parquet", vec![("t", Arc::new(TimestampMicrosecondArray::from(ts)))]);
        let p = profile(&path, "t", None).await;
        let (buckets, other) = histogram(&p.chart);
        assert_eq!(other, 0);
        assert_eq!(buckets.iter().map(|b| b.2).sum::<usize>(), 30);
        // range 29 min / 20 = 87 s -> 100 s; edges on whole seconds.
        assert_eq!(buckets[0].0, "2024-01-02T03:03:20");
        assert_eq!(buckets[0].1, "2024-01-02T03:05:00");
        let p = profile(&path, "t", Some("\"t\" >= '2024-01-02T03:03:20' AND \"t\" < '2024-01-02T03:05:00'")).await;
        assert_eq!(p.total_rows, buckets[0].2);
    }

    #[tokio::test]
    async fn nested_columns_get_counts_but_no_chart() {
        let mut list = ListBuilder::new(Int32Builder::new());
        list.values().append_value(1);
        list.append(true);
        list.append(false);
        list.append(true);
        let path = fixture("nested.parquet", vec![("li", Arc::new(list.finish()))]);
        let p = profile(&path, "li", None).await;
        assert_eq!((p.total_rows, p.null_count, p.distinct_count), (3, 1, None));
        assert_eq!(p.chart, ProfileChart::Unsupported);
    }

    #[tokio::test]
    async fn column_names_are_quoted_and_unknown_ones_refused() {
        let path = fixture(
            "names.parquet",
            vec![
                ("qu\"ote", Arc::new(Int64Array::from(vec![1, 1, 2]))),
                ("MixedCase", Arc::new(Int64Array::from(vec![1, 2, 3]))),
            ],
        );
        assert_eq!(top_values(&profile(&path, "qu\"ote", None).await.chart).0[0], (Value::from(1), 2));
        assert_eq!(profile(&path, "MixedCase", None).await.distinct_count, Some(3));
        let err = column_counts(&ParquetCache::new(), &path, "missing", None).await.unwrap_err();
        assert!(err.contains("no column named \"missing\""), "{err}");
    }

    /// A profile is a count and a chart of what the panel says is on
    /// screen. Over a file that was replaced under the tab it would be a
    /// picture of another file's values beside the old file's row count.
    #[tokio::test]
    async fn a_profile_after_the_file_was_rewritten_is_refused() {
        let path = fixture(
            "rewritten_profile.parquet",
            vec![("id", Arc::new(Int64Array::from(vec![1, 2, 3])) as ArrayRef)],
        );
        let cache = ParquetCache::new();
        let counted = column_counts(&cache, &path, "id", None).await.unwrap();
        assert_eq!(counted.total_rows, 3);

        let replacement = RecordBatch::try_from_iter(vec![(
            "id",
            Arc::new(Int64Array::from(vec![9])) as ArrayRef,
        )])
        .unwrap();
        test_support::rewrite_parquet(std::path::Path::new(&path), &replacement);

        let err = column_counts(&cache, &path, "id", None).await.unwrap_err();
        assert!(err.contains("Refresh"), "{err}");
        let err = column_chart(&cache, &path, "id", None, &counted).await.unwrap_err();
        assert!(err.contains("Refresh"), "{err}");

        cache.evict(&path).await.unwrap();
        let counted = column_counts(&cache, &path, "id", None).await.unwrap();
        assert_eq!(counted.total_rows, 1);
    }

    /// Exercise the same literals a bar click sends, through the grid's
    /// count service rather than repeating the histogram's arithmetic.
    async fn assert_chart_round_trip(path: &str, p: &Profiled) {
        let cache = ParquetCache::new();
        let col = quote_identifier(&p.column);
        let quoted = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let literal = |value: &Value| -> String {
            let text = value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string());
            match p.kind {
                ColumnKind::Integer | ColumnKind::Decimal | ColumnKind::Boolean => text,
                ColumnKind::Float if !["NaN", "Infinity", "-Infinity"].contains(&text.as_str()) => text,
                _ => quoted(&text),
            }
        };
        let predicates: Vec<(String, usize)> = match &p.chart {
            ProfileChart::TopValues { values, other } => {
                assert_eq!(values.iter().map(|v| v.count).sum::<usize>() + other + p.null_count, p.total_rows);
                values.iter().map(|v| {
                    let target = if p.kind == ColumnKind::Binary {
                        format!("encode(CAST({col} AS BYTEA), 'hex')")
                    } else { col.clone() };
                    let predicate = if p.kind == ColumnKind::Float && v.value.as_str() == Some("NaN") {
                        format!("isnan(CAST({col} AS DOUBLE))")
                    } else { format!("{target} = {}", literal(&v.value)) };
                    (predicate, v.count)
                }).collect()
            }
            ProfileChart::Histogram { buckets, other } => {
                assert_eq!(buckets.iter().map(|b| b.count).sum::<usize>() + other + p.null_count, p.total_rows);
                buckets.iter().map(|b| {
                    let lo = literal(&Value::String(b.lower.clone()));
                    let hi = literal(&Value::String(b.upper.clone()));
                    let op = if b.upper_inclusive { "<=" } else { "<" };
                    (format!("{col} >= {lo} AND {col} {op} {hi}"), b.count)
                }).collect()
            }
            ProfileChart::Unsupported => panic!("expected a chart"),
        };
        for (predicate, expected) in predicates {
            let actual = crate::services::parquet::count_data(&cache, path, Some(predicate.clone())).await.unwrap();
            assert_eq!(actual, expected, "{predicate}");
        }
    }

    #[tokio::test]
    async fn large_integers_and_high_precision_decimals_keep_exact_values() {
        use arrow::array::Decimal128Array;
        let integers = (0..30).map(|i| (1i64 << 60) + i).collect::<Vec<_>>();
        let amounts = integers.iter().map(|i| *i as i128).collect::<Vec<_>>();
        let path = fixture("exact.parquet", vec![
            ("id", Arc::new(Int64Array::from(integers))),
            ("amount", Arc::new(Decimal128Array::from(amounts).with_precision_and_scale(30, 2).unwrap())),
        ]);
        for col in ["id", "amount"] {
            let p = profile(&path, col, None).await;
            assert_eq!(top_values(&p.chart).1, 10);
            assert_chart_round_trip(&path, &p).await;
        }
    }

    #[tokio::test]
    async fn extreme_finite_floats_fall_back_to_values_without_invalid_sql() {
        for (name, xs) in [
            ("tiny.parquet", (0..30).map(|i| i as f64 * 1e-310).collect::<Vec<_>>()),
            ("huge.parquet", (0..30).map(|i| -1e308 + i as f64 * 6e306).collect()),
        ] {
            let path = fixture(name, vec![("x", Arc::new(Float64Array::from(xs)))]);
            let p = profile(&path, "x", None).await;
            assert!(matches!(p.chart, ProfileChart::TopValues { .. }));
            assert_chart_round_trip(&path, &p).await;
        }
    }

    #[tokio::test]
    async fn times_include_the_last_instant_without_rendering_twenty_four_hours() {
        use arrow::array::{Time32MillisecondArray, Time64MicrosecondArray};
        let ms = (0..30).map(|i| 86_370_999 + i * 1_000).collect::<Vec<_>>();
        let us = (0..30).map(|i| 86_370_999_999 + i * 1_000_000).collect::<Vec<_>>();
        let path = fixture("day_end.parquet", vec![
            ("ms", Arc::new(Time32MillisecondArray::from(ms))),
            ("us", Arc::new(Time64MicrosecondArray::from(us))),
        ]);
        for col in ["ms", "us"] {
            let p = profile(&path, col, None).await;
            let ProfileChart::Histogram { buckets, other } = &p.chart else { panic!("expected bins") };
            assert_eq!(*other, 0);
            assert!(buckets.last().unwrap().upper_inclusive);
            assert!(buckets.last().unwrap().upper.starts_with("23:59:59.999"));
            assert_chart_round_trip(&path, &p).await;
        }
    }

    #[tokio::test]
    async fn temporal_and_numeric_types_round_trip_on_both_sides_of_the_chart_threshold() {
        use arrow::array::{
            Date64Array, Decimal128Array, Float32Array, Time32SecondArray,
            Time32MillisecondArray, Time64MicrosecondArray, Time64NanosecondArray,
            TimestampNanosecondArray, UInt64Array,
        };
        for n in [20, 21] {
            let mut columns: Vec<(&str, ArrayRef)> = vec![
                ("date64", Arc::new(Date64Array::from((0..n).map(|i| Some((19723 + i) * 86_400_000)).chain([None]).collect::<Vec<_>>()))),
                ("seconds", Arc::new(Time32SecondArray::from((0..n).map(|i| Some((i * 60) as i32)).chain([None]).collect::<Vec<_>>()))),
                ("millis", Arc::new(Time32MillisecondArray::from((0..n).map(|i| Some((i * 60_000 + 999) as i32)).chain([None]).collect::<Vec<_>>()))),
                ("micros", Arc::new(Time64MicrosecondArray::from((0..n).map(|i| Some(i * 60_000_000 + 999_999)).chain([None]).collect::<Vec<_>>()))),
                ("nanos", Arc::new(Time64NanosecondArray::from((0..n).map(|i| Some(i * 60_000_000_000 + 999_999_999)).chain([None]).collect::<Vec<_>>()))),
                ("timestamp_ns", Arc::new(TimestampNanosecondArray::from((0..n).map(|i| Some(1_704_164_645_999_999_999 + i * 60_000_000_000)).chain([None]).collect::<Vec<_>>()))),
                ("decimal", Arc::new(Decimal128Array::from((0..n).map(|i| Some(i as i128 * 1_001 - 5_123)).chain([None]).collect::<Vec<_>>()).with_precision_and_scale(12, 3).unwrap())),
                ("uint64", Arc::new(UInt64Array::from((0..n).map(|i| Some(u64::MAX - i as u64)).chain([None]).collect::<Vec<_>>()))),
            ];
            let floats = Float32Array::from((0..n).map(|i| Some(i as f32 * 0.25)).chain([None]).collect::<Vec<_>>());
            columns.push(("float16", arrow::compute::cast(&floats, &DataType::Float16).unwrap()));
            // A named zone, and the repeated local hour at the US DST fall-back.
            for (name, zone) in [("tokyo", "Asia/Tokyo"), ("dst", "America/New_York")] {
                columns.push((name, Arc::new(TimestampMicrosecondArray::from(
                    (0..n).map(|i| Some(1_730_610_000_123_456 + i * 600_000_000)).chain([None]).collect::<Vec<_>>()
                ).with_timezone(zone))));
            }
            let path = fixture(&format!("types_{n}.parquet"), columns);
            for column in ["date64", "seconds", "millis", "micros", "nanos", "timestamp_ns", "decimal", "uint64", "float16", "tokyo", "dst"] {
                let p = profile(&path, column, None).await;
                assert_eq!(p.distinct_count, Some(n as usize), "{column}");
                assert_eq!(p.null_count, 1, "{column}");
                if n == 20 || column == "uint64" {
                    assert!(matches!(p.chart, ProfileChart::TopValues { .. }), "{column}");
                } else {
                    assert!(matches!(p.chart, ProfileChart::Histogram { .. }), "{column}");
                }
                assert_chart_round_trip(&path, &p).await;
            }
        }
    }

    #[tokio::test]
    async fn float16_non_finite_values_round_trip_or_are_reported_outside_bins() {
        use arrow::array::Float32Array;
        for n in [3, 25] {
            let xs = Float32Array::from((0..n).map(|i| Some(i as f32))
                .chain([Some(f32::NAN), Some(f32::INFINITY), Some(f32::NEG_INFINITY), None]).collect::<Vec<_>>());
            let path = fixture(&format!("half_special_{n}.parquet"), vec![("x", arrow::compute::cast(&xs, &DataType::Float16).unwrap())]);
            let p = profile(&path, "x", None).await;
            assert_eq!(p.distinct_count, Some(n + 3));
            assert_eq!(p.null_count, 1);
            if n == 25 { assert_eq!(histogram(&p.chart).1, 3); }
            assert_chart_round_trip(&path, &p).await;
        }
    }

    #[tokio::test]
    async fn empty_text_binary_and_quoted_names_round_trip() {
        use arrow::array::BinaryArray;
        let path = fixture("empty_values.parquet", vec![
            ("a\" AND b", Arc::new(StringArray::from(vec![Some(""), Some("   "), Some("a'b"), None]))),
            ("bin", Arc::new(BinaryArray::from(vec![Some(&b""[..]), Some(&b"\x00\xff"[..]), Some(&b" "[..]), None]))),
        ]);
        for column in ["a\" AND b", "bin"] {
            assert_chart_round_trip(&path, &profile(&path, column, None).await).await;
        }
        let filtered = profile(&path, "bin", Some("\"a\"\" AND b\" = '' OR \"a\"\" AND b\" IS NULL")).await;
        assert_eq!((filtered.total_rows, filtered.null_count), (2, 1));
        assert_eq!(top_values(&filtered.chart).0, vec![(Value::String(String::new()), 1)]);
    }

    #[test]
    fn nice_widths_are_one_two_or_five_times_a_power_of_ten() {
        assert_eq!(nice_ceil(4.95), 5.0);
        assert_eq!(nice_ceil(1.45), 2.0);
        assert_eq!(nice_ceil(0.12), 0.2);
        assert_eq!(nice_ceil(7.0), 10.0);
        assert_eq!(nice_ceil(100.0), 100.0);
        assert_eq!(nice_ceil(0.001), 0.001);
    }

    #[test]
    fn edges_start_on_a_multiple_of_the_width_and_cover_the_maximum() {
        assert_eq!(bucket_edges(3.0, 99.0, 5.0).len(), 20);
        assert_eq!(bucket_edges(3.0, 99.0, 5.0)[0], (0.0, 5.0));
        assert_eq!(bucket_edges(-7.0, -7.0, 1.0), vec![(-7.0, -6.0)]);
        assert_eq!(bucket_edges(-2.5, 2.5, 2.0), vec![(-4.0, -2.0), (-2.0, 0.0), (0.0, 2.0), (2.0, 4.0)]);
    }
}
