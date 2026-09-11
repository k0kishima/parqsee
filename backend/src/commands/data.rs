use crate::commands::guarded;
use crate::services::access::FileAccess;
use crate::services::parquet::ParquetCache;
use crate::services::{export, parquet};
use std::sync::Arc;

// No license check here: the free tier reads rows like the full version
// (see `services::store`); what it limits is enforced in the webview.

#[tauri::command]
pub async fn read_parquet_data(
    cache: tauri::State<'_, ParquetCache>,
    path: String,
    offset: usize,
    limit: usize,
    filter: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    guarded("Reading the page", async {
        parquet::read_data(&cache, &path, offset, limit, filter).await
    })
    .await
}

#[tauri::command]
pub async fn count_parquet_data(
    cache: tauri::State<'_, ParquetCache>,
    path: String,
    filter: Option<String>,
) -> Result<usize, String> {
    guarded("Counting rows", async {
        parquet::count_data(&cache, &path, filter).await
    })
    .await
}

#[tauri::command]
pub async fn evict_cache(
    cache: tauri::State<'_, ParquetCache>,
    path: String,
) -> Result<(), String> {
    guarded("Closing the file", cache.evict(&path)).await
}

/// Writes the export and, once it has succeeded, records its folder as
/// where the next save panel starts (`export_default_dir`).
// The parameters are the IPC surface the webview calls with; folding them
// into a struct would change every call site for no gain.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_data(
    cache: tauri::State<'_, ParquetCache>,
    access: tauri::State<'_, Arc<FileAccess>>,
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
    filter: Option<String>,
) -> Result<usize, String> {
    guarded("The export", async {
        let rows = export::export_data(
            &cache,
            source_path,
            export_path.clone(),
            format,
            offset,
            limit,
            filter,
        )
        .await?;
        access.remember_export(&export_path);
        Ok(rows)
    })
    .await
}

/// The folder the save panel for an export of `source_path` should start
/// in, or `None` for the panel's own default. See
/// `FileAccess::export_default_dir` for the order.
#[tauri::command]
pub async fn export_default_dir(
    access: tauri::State<'_, Arc<FileAccess>>,
    source_path: String,
) -> Result<Option<String>, String> {
    guarded("Choosing the export folder", async { Ok(access.export_default_dir(&source_path)) }).await
}
