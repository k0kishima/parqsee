use serde::{Deserialize, Serialize};
use tauri::command;

use crate::commands::guarded;
use crate::services::parquet::{batches_to_rows, execute_sql_limited, ParquetCache};

/// Upper bound on rows returned to the webview from one query. Rendering and
/// the JSON round trip both scale with rows x columns; beyond this the UI
/// asks the user to narrow the query instead.
pub const MAX_QUERY_ROWS: usize = 10_000;

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<QueryColumn>,
    /// One JSON object per row, already rendered webview-safe by
    /// `batches_to_rows` (decimals and big integers as strings).
    pub rows: Vec<serde_json::Value>,
    pub execution_time_ms: u128,
    /// True when the result was cut at `max_rows`.
    pub truncated: bool,
    pub max_rows: usize,
}

#[command]
pub async fn execute_sql(
    cache: tauri::State<'_, ParquetCache>,
    file_path: String,
    query: String,
) -> Result<QueryResult, String> {
    guarded("The query", run_query(&cache, &file_path, &query)).await
}

/// The SQL view's query, minus the Tauri plumbing, so the E2E bridge
/// (`examples/bridge.rs`) runs exactly what the command runs.
pub async fn run_query(cache: &ParquetCache, file_path: &str, query: &str) -> Result<QueryResult, String> {
    let start = std::time::Instant::now();

    let (batches, schema, truncated) =
        execute_sql_limited(cache, file_path, query, Some(MAX_QUERY_ROWS)).await?;

    let columns: Vec<QueryColumn> = schema
        .fields()
        .iter()
        .map(|f| QueryColumn {
            name: f.name().clone(),
            data_type: f.data_type().to_string(),
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
