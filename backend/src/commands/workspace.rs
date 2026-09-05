//! Workspace roots: the folders the explorer browses. Under the sandbox a
//! root is readable because the folder dialog granted it (this session) or
//! because its bookmark was resolved at launch; `FileAccess` holds the grant
//! until the root is removed.

use crate::models::{SessionTabInput, SessionTabs, WorkspaceRoot};
use crate::services::access::FileAccess;
use std::sync::Arc;

#[tauri::command]
pub async fn list_workspace_roots(
    access: tauri::State<'_, Arc<FileAccess>>,
) -> Result<Vec<WorkspaceRoot>, String> {
    Ok(access.roots())
}

#[tauri::command]
pub async fn add_workspace_root(
    access: tauri::State<'_, Arc<FileAccess>>,
    path: String,
) -> Result<WorkspaceRoot, String> {
    access.add_root(&path)
}

#[tauri::command]
pub async fn remove_workspace_root(
    access: tauri::State<'_, Arc<FileAccess>>,
    path: String,
) -> Result<(), String> {
    access.remove_root(&path);
    Ok(())
}

/// The tabs of the last session, each marked available or not. The webview
/// reopens the available ones through `open_parquet_file` — not through
/// `remember_file`, which would reorder Recent Files — and reports the rest.
#[tauri::command]
pub async fn list_session_tabs(
    access: tauri::State<'_, Arc<FileAccess>>,
) -> Result<SessionTabs, String> {
    Ok(access.session_tabs())
}

/// Replace the saved session with the tabs open now, in order, and the
/// active one's path. Called on every change worth keeping, once the
/// launch-time restore has finished.
#[tauri::command]
pub async fn save_session(
    access: tauri::State<'_, Arc<FileAccess>>,
    tabs: Vec<SessionTabInput>,
    active: Option<String>,
) -> Result<(), String> {
    access.save_session(
        tabs.into_iter().map(|t| (t.path, t.state)).collect(),
        active,
    )
}
