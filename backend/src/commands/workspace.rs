//! Workspace roots: the folders the explorer browses. Under the sandbox a
//! root is readable because the folder dialog granted it (this session) or
//! because its bookmark was resolved at launch; `FileAccess` holds the grant
//! until the root is removed.

use crate::models::WorkspaceRoot;
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
