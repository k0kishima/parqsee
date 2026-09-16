//! The column profile: what one column holds under the grid's filter, for
//! the panel that opens beside the grid — the row count, how many are
//! NULL, how many distinct values there are, and a chart of the values.
//!
//! Everything is a query over the shared session (`execute_sql_with_cache`,
//! so the filter goes through the same read-only check the grid's does),
//! with the grid's `WHERE` fragment applied, so the panel describes the rows
//! the grid shows. Two or three queries per profile: the counts, then the
//! chart's own — and the histogram's range before its buckets.
//!
//! Which chart a column gets is decided here from the distinct count, not
//! from the type alone: a column with at most `TOP_VALUES` distinct values
//! is listed in full whatever its type (a status code, a boolean, a year),
//! and past that numbers and dates are binned into equal-width buckets while
//! text and binary keep their `TOP_VALUES` commonest values with the rest
//! counted as `other`.
//!
//! The session runs single-partition (see `ParquetCache::get_or_create_session`),
//! so every query here is a single-threaded scan; the webview only asks
//! when the panel is open, never on opening a file.

use arrow::array::{Array, Int64Array};
use arrow::datatypes::{DataType, TimeUnit};
use arrow::record_batch::RecordBatch;
use serde_json::Value;

use crate::models::{ColumnKind, ColumnProfile, HistogramBucket, ProfileChart, ValueCount};
use crate::services::parquet::{
    batches_to_rows, execute_sql_with_cache, where_clause, ParquetCache,
};

/// How many values a `TopValues` chart lists, and the most distinct values
/// a column may have and still be listed in full. Twenty rows fit the panel
/// without scrolling past the counts above them.
pub const TOP_VALUES: usize = 20;

/// How many buckets a histogram aims for. The widths are rounded to 1, 2 or
/// 5 times a power of ten (whole days for dates, whole seconds for times),
/// so the actual count lands between half of this and one more.
pub const HISTOGRAM_BUCKETS: usize = 20;

/// DataFusion lower-cases bare identifiers, so `MixedCase` resolves to
/// nothing; the filter bar quotes the same way.
fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

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

/// Profile `column` of the file at `path` over the rows `filter` keeps.
pub async fn profile_column(
    cache: &ParquetCache,
    path: &str,
    column: &str,
    filter: Option<String>,
) -> Result<ColumnProfile, String> {
    let metadata = cache.get_or_create_metadata(path).await?;
    let info = metadata
        .columns
        .iter()
        .find(|c| c.name == column)
        .ok_or_else(|| format!("This file has no column named \"{}\"", column))?;
    let kind = info.kind;
    let col = quote_identifier(column);
    let filter = where_clause(filter.as_deref()).map(str::to_string);
    let filter = filter.as_deref();

    // COUNT(DISTINCT) is not defined on a list or a struct, and an
    // interval's ordering is not one a chart could use either.
    let countable = !matches!(kind, ColumnKind::Nested | ColumnKind::Other);
    let counts_query = if countable {
        format!(
            "SELECT COUNT(*), COUNT({col}), COUNT(DISTINCT {col}) FROM t{}",
            where_sql(filter, &[])
        )
    } else {
        format!("SELECT COUNT(*), COUNT({col}) FROM t{}", where_sql(filter, &[]))
    };
    let (batches, _) = execute_sql_with_cache(cache, path, &counts_query).await?;
    let total_rows = count_cell(&batches, 0)?;
    let non_null = count_cell(&batches, 1)?;
    let distinct_count = if countable { Some(count_cell(&batches, 2)?) } else { None };

    let chart = match distinct_count {
        None => ProfileChart::Unsupported,
        Some(distinct) if distinct <= TOP_VALUES => top_values(cache, path, &col, filter, non_null).await?,
        Some(_) if matches!(
            kind,
            ColumnKind::Integer | ColumnKind::Float | ColumnKind::Decimal | ColumnKind::Temporal
        ) =>
        {
            histogram(cache, path, &col, kind, filter, non_null).await?
        }
        Some(_) => top_values(cache, path, &col, filter, non_null).await?,
    };

    Ok(ColumnProfile {
        column: column.to_string(),
        kind,
        total_rows,
        null_count: total_rows.saturating_sub(non_null),
        distinct_count,
        chart,
    })
}

/// The `TOP_VALUES` commonest non-null values. Ties are broken by the value
/// itself so the list is the same on every run.
async fn top_values(
    cache: &ParquetCache,
    path: &str,
    col: &str,
    filter: Option<&str>,
    non_null: usize,
) -> Result<ProfileChart, String> {
    let query = format!(
        "SELECT {col} AS \"value\", COUNT(*) AS \"n\" FROM t{} GROUP BY {col} ORDER BY \"n\" DESC, \"value\" ASC LIMIT {}",
        where_sql(filter, &[format!("{col} IS NOT NULL")]),
        TOP_VALUES
    );
    let (batches, _) = execute_sql_with_cache(cache, path, &query).await?;
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

/// The SQL that turns the column into the number the buckets are computed
/// over. A double for numbers; the raw unit count for temporal columns —
/// arrow casts `Date32` and `Time32` to a 32-bit integer only, the rest go
/// straight to a 64-bit one.
fn axis_expr(axis: &Axis, col: &str) -> String {
    match axis {
        Axis::Number => format!("CAST({col} AS DOUBLE)"),
        Axis::Temporal(DataType::Date32 | DataType::Time32(_)) => {
            format!("CAST(CAST({col} AS INT) AS BIGINT)")
        }
        Axis::Temporal(_) => format!("CAST({col} AS BIGINT)"),
    }
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
            Ok(((edge * scale).round() / scale).to_string())
        }
        Axis::Temporal(data_type) => {
            let raw = Int64Array::from(vec![edge as i64]);
            let through = match data_type {
                DataType::Date32 | DataType::Time32(_) => DataType::Int32,
                _ => DataType::Int64,
            };
            let narrowed = arrow::compute::cast(&raw, &through).map_err(|e| e.to_string())?;
            let typed = arrow::compute::cast(&narrowed, data_type).map_err(|e| e.to_string())?;
            arrow::util::display::array_value_to_string(&typed, 0).map_err(|e| e.to_string())
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
    cache: &ParquetCache,
    path: &str,
    col: &str,
    kind: ColumnKind,
    filter: Option<&str>,
    non_null: usize,
) -> Result<ProfileChart, String> {
    let mut conditions = vec![format!("{col} IS NOT NULL")];
    if kind == ColumnKind::Float {
        // NaN and the infinities have no place on the axis. `x - x` is 0 for
        // every finite value and NaN for the rest, and NaN compares equal to
        // nothing, so this keeps exactly the finite ones — without relying
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
    let (batches, schema) = execute_sql_with_cache(cache, path, &range_query).await?;
    let data_type = schema.field(0).data_type().clone();
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

    let width = bucket_width(&axis, kind, max - min);
    let edges = bucket_edges(min, max, width);
    let first = edges[0].0;

    // Which bucket each row falls in, counted. For the temporal axis the
    // arithmetic is integer division on whole units, so an edge that is a
    // whole day never lands a row on the wrong side of it through rounding.
    let bucket_expr = match &axis {
        Axis::Number => format!("FLOOR(({} - {}) / {})", axis_expr(&axis, col), first, width),
        Axis::Temporal(_) => format!("({} - {}) / {}", axis_expr(&axis, col), first as i64, width as i64),
    };
    let buckets_query = format!(
        "SELECT {bucket_expr} AS \"b\", COUNT(*) AS \"n\" FROM t{} GROUP BY \"b\" ORDER BY \"b\"",
        where_sql(filter, &conditions)
    );
    let (batches, _) = execute_sql_with_cache(cache, path, &buckets_query).await?;
    let mut counts = vec![0usize; edges.len()];
    for row in batches_to_rows(&batches)? {
        let index = row
            .get("b")
            .and_then(Value::as_f64)
            .ok_or_else(|| "The profile query returned no bucket column".to_string())?;
        // A value on the far edge can round into one bucket past the last;
        // it belongs to the last one.
        let index = (index.max(0.0) as usize).min(edges.len() - 1);
        counts[index] += count_of(&row, "n")?;
    }

    let buckets = edges
        .iter()
        .zip(counts)
        .map(|((lower, upper), count)| {
            Ok(HistogramBucket {
                lower: edge_label(&axis, *lower, width)?,
                upper: edge_label(&axis, *upper, width)?,
                count,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
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

    async fn profile(path: &str, column: &str, filter: Option<&str>) -> ColumnProfile {
        profile_column(&ParquetCache::new(), path, column, filter.map(str::to_string))
            .await
            .unwrap_or_else(|e| panic!("{column}: {e}"))
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
        let err = profile_column(&ParquetCache::new(), &path, "missing", None).await.unwrap_err();
        assert!(err.contains("no column named \"missing\""), "{err}");
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
