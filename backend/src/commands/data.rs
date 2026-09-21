use crate::commands::guarded;
use crate::services::access::FileAccess;
use crate::services::parquet::ParquetCache;
use crate::models::{ColumnProfile, SortSpec};
use crate::services::profile_requests::ProfileRequests;
use crate::services::{export, parquet, profile};
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
    sort: Option<SortSpec>,
) -> Result<Vec<serde_json::Value>, String> {
    guarded("Reading the page", async {
        parquet::read_data(&cache, &path, offset, limit, filter, sort).await
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

/// The column profile for the panel beside the grid; `filter` is the
/// grid's `WHERE` fragment, so the panel describes the rows on screen.
/// `request_id` is what `cancel_profile` ends this scan by.
#[tauri::command]
pub async fn profile_column(
    cache: tauri::State<'_, ParquetCache>,
    requests: tauri::State<'_, ProfileRequests>,
    path: String,
    column: String,
    filter: Option<String>,
    request_id: Option<String>,
) -> Result<ColumnProfile, String> {
    guarded("Profiling the column", async {
        requests
            .run(request_id, profile::profile_column(&cache, &path, &column, filter))
            .await
    })
    .await
}

/// Stop a profile the webview has stopped waiting for — either panel's, a
/// file's column or a query result's. The panel calls this as it asks for
/// the next one, because a profile's memory is reserved out of the file
/// session's pool and the scan nobody wants would otherwise leave the one
/// on screen without it (`services::profile_requests`).
#[tauri::command]
pub async fn cancel_profile(
    requests: tauri::State<'_, ProfileRequests>,
    request_id: String,
) -> Result<(), String> {
    guarded("Cancelling the profile", async {
        requests.cancel(&request_id);
        Ok(())
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
    sort: Option<SortSpec>,
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
            sort,
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
