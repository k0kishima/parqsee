use arrow::datatypes::DataType;
use tauri::command;

use crate::commands::guarded;
use crate::models::{QueryChartType, QueryColumn, QueryResult};
use crate::services::parquet::{batches_to_rows, execute_sql_limited, ParquetCache};

/// Upper bound on rows returned to the webview from one query. Rendering and
/// the JSON round trip both scale with rows x columns; beyond this the UI
/// asks the user to narrow the query instead.
pub const MAX_QUERY_ROWS: usize = 10_000;

#[command]
pub async fn execute_sql(
    cache: tauri::State<'_, ParquetCache>,
    file_path: String,
    query: String,
) -> Result<QueryResult, String> {
    guarded("The query", async {
        run_query(&cache, &file_path, &query).await
    })
    .await
}

/// The SQL view's query, minus the Tauri plumbing, so the E2E bridge
/// (`examples/bridge.rs`) runs exactly what the command runs.
pub async fn run_query(
    cache: &ParquetCache,
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

    Ok(QueryResult {
        columns,
        rows,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        max_rows: MAX_QUERY_ROWS,
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
}
