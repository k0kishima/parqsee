use crate::commands::guarded;
use crate::services::parquet::ParquetCache;
use crate::services::{export, parquet};

#[tauri::command]
pub async fn read_parquet_data(
    cache: tauri::State<'_, ParquetCache>,
    path: String,
    offset: usize,
    limit: usize,
    filter: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    guarded("Reading the page", parquet::read_data(&cache, &path, offset, limit, filter)).await
}

#[tauri::command]
pub async fn count_parquet_data(
    cache: tauri::State<'_, ParquetCache>,
    path: String,
    filter: Option<String>,
) -> Result<usize, String> {
    guarded("Counting rows", parquet::count_data(&cache, &path, filter)).await
}

#[tauri::command]
pub async fn evict_cache(
    cache: tauri::State<'_, ParquetCache>,
    path: String,
) -> Result<(), String> {
    cache.evict(&path).await
}

#[tauri::command]
pub async fn export_data(
    cache: tauri::State<'_, ParquetCache>,
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
    filter: Option<String>,
) -> Result<usize, String> {
    guarded(
        "The export",
        export::export_data(&cache, source_path, export_path, format, offset, limit, filter),
    )
    .await
}
