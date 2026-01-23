use arrow::json::LineDelimitedWriter;
use datafusion::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<QueryColumn>,
    pub rows: Vec<serde_json::Map<String, serde_json::Value>>,
    pub execution_time_ms: u128,
}

#[command]
pub async fn execute_sql(file_path: String, query: String) -> Result<QueryResult, String> {
    let start = std::time::Instant::now();

    // Create DataFusion context
    let ctx = SessionContext::new();

    // Register the parquet file as a table named "t"
    let options = ParquetReadOptions::default();
    ctx.register_parquet("t", &file_path, options)
        .await
        .map_err(|e| format!("Failed to register parquet file: {}", e))?;

    // Execute the query
    let df = ctx
        .sql(&query)
        .await
        .map_err(|e| format!("SQL execution failed: {}", e))?;

    // Get schema for column info
    let schema = df.schema();
    let columns: Vec<QueryColumn> = schema
        .fields()
        .iter()
        .map(|f| QueryColumn {
            name: f.name().clone(),
            data_type: f.data_type().to_string(),
        })
        .collect();

    // Collect results
    let batches = df
        .collect()
        .await
        .map_err(|e| format!("Failed to collect results: {}", e))?;

    // Convert to JSON using LineDelimitedWriter
    let mut buf = Vec::new();
    {
        let mut writer = LineDelimitedWriter::new(&mut buf);
        for batch in &batches {
            writer
                .write(batch)
                .map_err(|e| format!("Failed to write batch: {}", e))?;
        }
        writer
            .finish()
            .map_err(|e| format!("Failed to finish writing: {}", e))?;
    }

    // Parse lines back to JSON objects
    let rows: Result<Vec<serde_json::Map<String, serde_json::Value>>, _> =
        serde_json::Deserializer::from_slice(&buf)
            .into_iter::<serde_json::Map<String, serde_json::Value>>()
            .collect();

    let rows = rows.map_err(|e| format!("Failed to parse JSON results: {}", e))?;

    let duration = start.elapsed().as_millis();

    Ok(QueryResult {
        columns,
        rows,
        execution_time_ms: duration,
    })
}
