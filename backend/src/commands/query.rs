use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use tauri::command;

use crate::commands::guarded;
use crate::models::{ColumnProfile, QueryChartType, QueryColumn, QueryResult};
use crate::services::parquet::{batches_to_rows, execute_sql_limited, where_clause, ParquetCache};
use crate::services::profile::{column_kind_of, profile, ProfileSource};
use crate::services::profile_requests::ProfileRequests;
use crate::services::query_results::{column_alias, QueryResults};

/// Upper bound on rows returned to the webview from one query. Rendering and
/// the JSON round trip both scale with rows x columns; beyond this the UI
/// asks the user to narrow the query instead.
pub const MAX_QUERY_ROWS: usize = 10_000;

#[command]
pub async fn execute_sql(
    cache: tauri::State<'_, ParquetCache>,
    results: tauri::State<'_, QueryResults>,
    file_path: String,
    query: String,
) -> Result<QueryResult, String> {
    guarded("The query", async {
        run_query(&cache, &results, &file_path, &query).await
    })
    .await
}

/// Profile column `column_index` of a kept result over the rows `filter`
/// keeps. The rows are the ones the grid has — at most `MAX_QUERY_ROWS`
/// of them — so a truncated result profiles its first rows and the panel
/// says so; nothing here re-runs the query.
#[command]
pub async fn profile_query_column(
    results: tauri::State<'_, QueryResults>,
    requests: tauri::State<'_, ProfileRequests>,
    result_id: String,
    column_index: usize,
    filter: Option<String>,
    request_id: Option<String>,
) -> Result<ColumnProfile, String> {
    guarded("The column profile", async {
        requests
            .run(
                request_id,
                run_profile_query_column(&results, &result_id, column_index, filter),
            )
            .await
    })
    .await
}

/// The profile of a result column, minus the Tauri plumbing, so the E2E
/// bridge runs exactly what the command runs.
pub async fn run_profile_query_column(
    results: &QueryResults,
    result_id: &str,
    column_index: usize,
    filter: Option<String>,
) -> Result<ColumnProfile, String> {
    let (name, data_type) = results.column(result_id, column_index)?;
    let ctx = results.session(result_id)?;
    let source = ProfileSource::Result(&ctx);
    profile(&source, &name, &column_alias(column_index), column_kind_of(&data_type), filter).await
}

/// The rows of a kept result that `filter` keeps, keyed by the names the
/// grid shows. A bar in the profile narrows the result the user already
/// has; it never rewrites their SQL, and it never runs the query again —
/// so the rows, the counts in the panel and the footer all describe the
/// same set, whatever the query would answer now.
#[command]
pub async fn filter_query_result(
    results: tauri::State<'_, QueryResults>,
    result_id: String,
    filter: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    guarded("Narrowing the result", async {
        run_filter_query_result(&results, &result_id, filter).await
    })
    .await
}

/// The narrowed rows, minus the Tauri plumbing, so the E2E bridge runs
/// exactly what the command runs.
pub async fn run_filter_query_result(
    results: &QueryResults,
    result_id: &str,
    filter: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let names = results.names(result_id)?;
    let ctx = results.session(result_id)?;
    let where_sql = match where_clause(filter.as_deref()) {
        Some(clause) => format!(" WHERE {clause}"),
        None => String::new(),
    };
    let df = ctx
        .sql(&format!("SELECT * FROM t{where_sql}"))
        .await
        .map_err(|e| format!("Failed to narrow the result: {e}"))?;
    let batches = df
        .collect()
        .await
        .map_err(|e| format!("Failed to narrow the result: {e}"))?;
    // Back to the names the grid renders by: the rows are addressed by
    // position inside the store and by name once they leave it.
    let named: Vec<RecordBatch> = batches
        .iter()
        .map(|b| {
            let schema = Arc::new(Schema::new(
                b.schema()
                    .fields()
                    .iter()
                    .enumerate()
                    .map(|(i, f)| Field::new(&names[i], f.data_type().clone(), f.is_nullable()))
                    .collect::<Vec<_>>(),
            ));
            RecordBatch::try_new(schema, b.columns().to_vec()).map_err(|e| e.to_string())
        })
        .collect::<Result<_, _>>()?;
    batches_to_rows(&named)
}

/// Let go of a result the webview will not ask about again. It calls this
/// when a re-run replaces one, when a superseded run's answer arrives
/// anyway, and when the tab holding it closes; the store's own caps are
/// the backstop for a call that never comes.
#[command]
pub async fn release_query_result(
    results: tauri::State<'_, QueryResults>,
    result_id: String,
) -> Result<(), String> {
    guarded("Releasing the result", async {
        results.release(&result_id);
        Ok(())
    })
    .await
}

/// The SQL view's query, minus the Tauri plumbing, so the E2E bridge
/// (`examples/bridge.rs`) runs exactly what the command runs.
pub async fn run_query(
    cache: &ParquetCache,
    results: &QueryResults,
    file_path: &str,
    query: &str,
) -> Result<QueryResult, String> {
    let start = std::time::Instant::now();

    let (batches, schema, truncated) =
        execute_sql_limited(cache, file_path, query, Some(MAX_QUERY_ROWS)).await?;

    let columns: Vec<QueryColumn> = schema
        .fields()
        .iter()
        .map(|f| QueryColumn {
            name: f.name().clone(),
            data_type: f.data_type().to_string(),
            chart_type: chart_type_of(f.data_type()),
        })
        .collect();

    let rows = batches_to_rows(&batches)?;
    // Kept in their own types, because the JSON above is not the data any
    // more: a decimal and a big integer are strings in it.
    let result_id = results.keep(&batches, &schema);

    Ok(QueryResult {
        columns,
        rows,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        max_rows: MAX_QUERY_ROWS,
        result_id,
    })
}

/// The chart's view of a result column's type. Taken from the schema
/// DataFusion planned, before `batches_to_rows` renders the values — see
/// `QueryChartType` for why the webview is not left to guess it.
pub fn chart_type_of(data_type: &DataType) -> QueryChartType {
    match data_type {
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64 => QueryChartType::Integer,
        DataType::Float16 | DataType::Float32 | DataType::Float64 => QueryChartType::Float,
        DataType::Decimal32(_, _)
        | DataType::Decimal64(_, _)
        | DataType::Decimal128(_, _)
        | DataType::Decimal256(_, _) => QueryChartType::Decimal,
        DataType::Date32 | DataType::Date64 => QueryChartType::Date,
        DataType::Timestamp(_, timezone) => QueryChartType::Timestamp {
            timezone: timezone.as_ref().map(|tz| tz.to_string()),
        },
        DataType::Utf8
        | DataType::LargeUtf8
        | DataType::Utf8View
        | DataType::Boolean
        | DataType::Time32(_)
        | DataType::Time64(_) => QueryChartType::Category,
        _ => QueryChartType::Unsupported,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::test_support::{temp_path, write_parquet};
    use arrow::array::{ArrayRef, Date32Array, Int64Array, RecordBatch, StringArray};
    use arrow::datatypes::{Field, Schema, TimeUnit};
    use std::sync::Arc;

    #[test]
    fn every_arrow_type_lands_on_one_chart_type() {
        use QueryChartType::*;
        let cases: Vec<(DataType, QueryChartType)> = vec![
            (DataType::Int8, Integer),
            (DataType::UInt64, Integer),
            (DataType::Float16, Float),
            (DataType::Float64, Float),
            (DataType::Decimal32(9, 2), Decimal),
            (DataType::Decimal64(18, 4), Decimal),
            (DataType::Decimal128(38, 10), Decimal),
            (DataType::Decimal256(76, 10), Decimal),
            (DataType::Date32, Date),
            (DataType::Date64, Date),
            (
                DataType::Timestamp(TimeUnit::Millisecond, None),
                Timestamp { timezone: None },
            ),
            (
                DataType::Timestamp(TimeUnit::Nanosecond, Some("+09:00".into())),
                Timestamp {
                    timezone: Some("+09:00".to_string()),
                },
            ),
            (DataType::Utf8, Category),
            (DataType::LargeUtf8, Category),
            (DataType::Utf8View, Category),
            (DataType::Boolean, Category),
            (DataType::Time32(TimeUnit::Second), Category),
            (DataType::Time64(TimeUnit::Nanosecond), Category),
            (DataType::Null, Unsupported),
            (DataType::Binary, Unsupported),
            (DataType::Duration(TimeUnit::Second), Unsupported),
            (
                DataType::List(Arc::new(Field::new("item", DataType::Int64, true))),
                Unsupported,
            ),
            (
                DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Int64)),
                Unsupported,
            ),
        ];
        for (data_type, expected) in cases {
            assert_eq!(chart_type_of(&data_type), expected, "{data_type}");
        }
    }

    #[test]
    fn chart_type_serializes_as_a_kind_tag() {
        assert_eq!(
            serde_json::to_value(QueryChartType::Timestamp {
                timezone: Some("UTC".into())
            })
            .unwrap(),
            serde_json::json!({ "kind": "timestamp", "timezone": "UTC" })
        );
        assert_eq!(
            serde_json::to_value(QueryChartType::Timestamp { timezone: None }).unwrap(),
            serde_json::json!({ "kind": "timestamp", "timezone": null })
        );
        assert_eq!(
            serde_json::to_value(QueryChartType::Category).unwrap(),
            serde_json::json!({ "kind": "category" })
        );
    }

    /// The chart type follows what the query computed, not the file: an
    /// aggregate over an integer column is a float, a CAST is what it says,
    /// and the type survives `batches_to_rows` turning the values to JSON.
    #[tokio::test]
    async fn result_columns_carry_the_planned_types() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("cat", DataType::Utf8, true),
            Field::new("n", DataType::Int64, true),
            Field::new("day", DataType::Date32, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec!["a", "a", "b"])) as ArrayRef,
                Arc::new(Int64Array::from(vec![1, 2, 3])),
                Arc::new(Date32Array::from(vec![19_000, 19_001, 19_002])),
            ],
        )
        .unwrap();
        let path = temp_path("query_chart_type", "agg.parquet");
        write_parquet(&path, &batch, None);
        let cache = ParquetCache::new();

        let result = run_query(
            &cache,
            &QueryResults::new(),
            &path.to_string_lossy(),
            "SELECT cat, avg(n) AS mean, CAST(sum(n) AS DECIMAL(10, 2)) AS total, CAST(count(*) AS VARCHAR) AS label, min(day) AS first_day FROM t GROUP BY cat ORDER BY cat",
        )
        .await
        .unwrap();

        let kinds: Vec<_> = result
            .columns
            .iter()
            .map(|c| c.chart_type.clone())
            .collect();
        assert_eq!(
            kinds,
            vec![
                QueryChartType::Category,
                QueryChartType::Float,
                QueryChartType::Decimal,
                QueryChartType::Category,
                QueryChartType::Date,
            ]
        );
        // What the webview receives.
        let json = serde_json::to_value(&result.columns).unwrap();
        assert_eq!(
            json[1]["chart_type"],
            serde_json::json!({ "kind": "float" })
        );
        assert_eq!(json[2]["data_type"], "Decimal128(10, 2)");
        assert_eq!(result.rows[0]["total"], "3.00");
    }

    /// Every Arrow family a result column can have, so a new one cannot
    /// reach the profile as `Other` without being named here.
    #[test]
    fn a_result_column_kind_is_read_from_the_planned_type() {
        use crate::models::ColumnKind::*;
        use arrow::datatypes::TimeUnit;
        let cases: Vec<(DataType, crate::models::ColumnKind)> = vec![
            (DataType::Boolean, Boolean),
            (DataType::Int8, Integer),
            (DataType::UInt64, Integer),
            (DataType::Float16, Float),
            (DataType::Float64, Float),
            (DataType::Decimal128(38, 2), Decimal),
            (DataType::Decimal256(60, 2), Decimal),
            (DataType::Utf8, Text),
            (DataType::LargeUtf8, Text),
            (DataType::Utf8View, Text),
            (DataType::Date32, Temporal),
            (DataType::Date64, Temporal),
            (DataType::Time32(TimeUnit::Second), Temporal),
            (DataType::Time64(TimeUnit::Nanosecond), Temporal),
            (DataType::Timestamp(TimeUnit::Microsecond, None), Temporal),
            (DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), Temporal),
            (DataType::Binary, Binary),
            (DataType::FixedSizeBinary(4), Binary),
            (DataType::List(Arc::new(Field::new("item", DataType::Int64, true))), Nested),
            (DataType::Struct(vec![Field::new("a", DataType::Int64, true)].into()), Nested),
            (DataType::Null, Other),
            (DataType::Duration(TimeUnit::Second), Other),
            // A dictionary's values would reach the panel through the JSON
            // rendering the SQL view already declines to trust for one.
            (DataType::Dictionary(Box::new(DataType::Int32), Box::new(DataType::Utf8)), Other),
        ];
        for (data_type, expected) in cases {
            assert_eq!(column_kind_of(&data_type), expected, "{data_type}");
        }
    }

    /// The whole way round for a result: run a query, keep it, profile a
    /// column of it by position. The values a profile lists have to be the
    /// ones the table shows, which is why the rows are kept as Arrow — a
    /// big integer and a decimal are strings by the time the grid has them.
    #[tokio::test]
    async fn a_kept_result_profiles_its_columns_by_position() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("grp", DataType::Utf8, true),
            Field::new("big", DataType::Int64, true),
            Field::new("day", DataType::Date32, true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(vec![Some("a"), Some("a"), None])) as ArrayRef,
                Arc::new(Int64Array::from(vec![
                    9_007_199_254_740_993,
                    9_007_199_254_740_993,
                    1,
                ])),
                Arc::new(Date32Array::from(vec![19_000, 19_001, 19_002])),
            ],
        )
        .unwrap();
        let path = temp_path("query_profile", "result.parquet");
        write_parquet(&path, &batch, None);
        let cache = ParquetCache::new();
        let results = QueryResults::new();

        // A column with no name of its own, and a decimal from a CAST.
        let result = run_query(
            &cache,
            &results,
            &path.to_string_lossy(),
            "SELECT grp, big * 2, big, CAST(big AS DECIMAL(38, 2)) AS exact, day FROM t ORDER BY day",
        )
        .await
        .unwrap();
        let id = result.result_id.clone().expect("a small result is kept");

        let first = run_profile_query_column(&results, &id, 0, None).await.unwrap();
        assert_eq!(first.column, "grp");
        assert_eq!((first.total_rows, first.null_count, first.distinct_count), (3, 1, Some(1)));

        // The second column is an expression: what DataFusion calls it is
        // not an identifier, and the profile reaches it by position anyway.
        let derived = run_profile_query_column(&results, &id, 1, None).await.unwrap();
        assert!(!derived.column.is_empty() && derived.column != "c1", "{}", derived.column);
        assert_eq!((derived.kind, derived.total_rows), (crate::models::ColumnKind::Integer, 3));

        // The integer past 2^53 keeps its exact digits, as the grid shows them.
        let big = run_profile_query_column(&results, &id, 2, None).await.unwrap();
        assert_eq!(big.kind, crate::models::ColumnKind::Integer);
        match &big.chart {
            crate::models::ProfileChart::TopValues { values, .. } => assert!(
                values.iter().any(|v| v.value == "9007199254740993" && v.count == 2),
                "{values:?}"
            ),
            other => panic!("expected values, got {other:?}"),
        }

        // A decimal from a CAST is a decimal, not the string the grid holds.
        let exact = run_profile_query_column(&results, &id, 3, None).await.unwrap();
        assert_eq!(exact.kind, crate::models::ColumnKind::Decimal);

        // A date is temporal, and the filter narrows the same rows the grid would.
        let day = run_profile_query_column(&results, &id, 4, None).await.unwrap();
        assert_eq!(day.kind, crate::models::ColumnKind::Temporal);
        let narrowed = run_profile_query_column(&results, &id, 4, Some("c4 = '2022-01-08'".into()))
            .await
            .unwrap();
        assert_eq!(narrowed.total_rows, 1);
    }

    /// Narrowing is over the rows the grid has, and the rows come back
    /// keyed the way the grid renders them — including the exact digits a
    /// big integer only has in Arrow.
    #[tokio::test]
    async fn a_narrowed_result_keeps_the_grid_s_own_rows() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("grp", DataType::Utf8, true),
            Field::new("big", DataType::Int64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec![Some("a"), Some("b"), None])) as ArrayRef,
                Arc::new(Int64Array::from(vec![9_007_199_254_740_993, 2, 3])),
            ],
        )
        .unwrap();
        let path = temp_path("query_profile", "narrow.parquet");
        write_parquet(&path, &batch, None);
        let cache = ParquetCache::new();
        let results = QueryResults::new();
        let result = run_query(&cache, &results, &path.to_string_lossy(), "SELECT grp, big FROM t")
            .await
            .unwrap();
        let id = result.result_id.clone().unwrap();

        let all = run_filter_query_result(&results, &id, None).await.unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0]["grp"], "a");
        assert_eq!(all[0]["big"], "9007199254740993");

        let narrowed = run_filter_query_result(&results, &id, Some("c0 = 'a'".into())).await.unwrap();
        assert_eq!(narrowed.len(), 1);
        assert_eq!(narrowed[0]["big"], "9007199254740993");

        let none = run_filter_query_result(&results, &id, Some("c0 IS NULL".into())).await.unwrap();
        assert_eq!(none.len(), 1);
        assert_eq!(none[0]["grp"], serde_json::Value::Null);

        results.release(&id);
        let gone = run_filter_query_result(&results, &id, None).await.unwrap_err();
        assert!(gone.contains("Run the query again"), "{gone}");
    }

    #[tokio::test]
    async fn a_result_with_no_rows_profiles_as_empty() {
        let schema = Arc::new(Schema::new(vec![Field::new("n", DataType::Int64, true)]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(Int64Array::from(vec![1, 2]))]).unwrap();
        let path = temp_path("query_profile", "empty.parquet");
        write_parquet(&path, &batch, None);
        let cache = ParquetCache::new();
        let results = QueryResults::new();

        let result = run_query(&cache, &results, &path.to_string_lossy(), "SELECT n FROM t WHERE n > 100")
            .await
            .unwrap();
        let id = result.result_id.clone().unwrap();
        let profile = run_profile_query_column(&results, &id, 0, None).await.unwrap();
        assert_eq!((profile.total_rows, profile.null_count, profile.distinct_count), (0, 0, Some(0)));
    }

    #[tokio::test]
    async fn profiling_a_released_result_says_to_run_the_query_again() {
        let schema = Arc::new(Schema::new(vec![Field::new("n", DataType::Int64, true)]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(Int64Array::from(vec![1]))]).unwrap();
        let path = temp_path("query_profile", "released.parquet");
        write_parquet(&path, &batch, None);
        let cache = ParquetCache::new();
        let results = QueryResults::new();
        let result = run_query(&cache, &results, &path.to_string_lossy(), "SELECT n FROM t").await.unwrap();
        let id = result.result_id.clone().unwrap();
        results.release(&id);

        let error = run_profile_query_column(&results, &id, 0, None).await.unwrap_err();
        assert!(error.contains("Run the query again"), "{error}");
        let missing = run_profile_query_column(&results, "r999", 0, None).await.unwrap_err();
        assert!(missing.contains("Run the query again"), "{missing}");
    }
}
