use crate::services::{export, parquet};

#[tauri::command]
pub async fn read_parquet_data(
    path: String,
    offset: usize,
    limit: usize,
    filter: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    parquet::read_data(&path, offset, limit, filter).await
}

#[tauri::command]
pub async fn count_parquet_data(path: String, filter: Option<String>) -> Result<usize, String> {
    parquet::count_data(&path, filter).await
}

#[tauri::command]
pub async fn export_data(
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<String, String> {
    export::export_data(source_path, export_path, format, offset, limit)
}
