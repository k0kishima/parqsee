use crate::commands::guarded;
use crate::models::{FileEntry, FileInfo, ParquetMetadata, RecentFile};
use crate::services::access::FileAccess;
use crate::services::opened::PendingOpen;
use crate::services::parquet::ParquetCache;
use crate::services::sample::sample_path;
use std::cmp::Ordering;
use std::fs::{metadata, read_dir, DirEntry};
use std::io;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;

/// Match the parquet extension case-insensitively. macOS and Windows preserve
/// case but treat `data.PARQUET` and `data.parquet` as the same file, and the
/// reader dispatches on file contents rather than on the extension.
fn has_parquet_extension(path: &str) -> bool {
    path.to_lowercase().ends_with(".parquet")
}

#[tauri::command]
pub async fn open_parquet_file(
    cache: tauri::State<'_, ParquetCache>,
    path: String,
) -> Result<ParquetMetadata, String> {
    guarded("Opening the file", async { cache.get_or_create_metadata(&path).await }).await
}

#[tauri::command]
pub async fn get_file_info(path: String) -> Result<FileInfo, String> {
    guarded("Reading the file's details", async {
        let file_path = Path::new(&path);
        let file_metadata = metadata(&path).map_err(|e| e.to_string())?;

        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();

        Ok(FileInfo {
            path,
            name: file_name,
            size: file_metadata.len(),
        })
    })
    .await
}

/// Whether the file can be reached. Goes through `FileAccess` because under
/// the sandbox a recent file is only visible once its bookmark is resolved.
#[tauri::command]
pub async fn check_file_exists(
    access: tauri::State<'_, Arc<FileAccess>>,
    path: String,
) -> Result<bool, String> {
    guarded("Checking the file", async { Ok(access.file_exists(&path)) }).await
}

/// Record a file that was just opened so Recent Files can reopen it after a
/// relaunch. Separate from `open_parquet_file`, which the grid also calls to
/// refresh a tab; only a user-initiated open should bump the list.
#[tauri::command]
pub async fn remember_file(
    app: tauri::AppHandle,
    access: tauri::State<'_, Arc<FileAccess>>,
    path: String,
) -> Result<RecentFile, String> {
    guarded("Recording the file", async {
        let recent = access.remember_file(&path)?;
        crate::menu::refresh_recent_menu(&app);
        Ok(recent)
    })
    .await
}

#[tauri::command]
pub async fn list_recent_files(
    access: tauri::State<'_, Arc<FileAccess>>,
) -> Result<Vec<RecentFile>, String> {
    guarded("Listing Recent Files", async { Ok(access.recent_files()) }).await
}

#[tauri::command]
pub async fn remove_recent_file(
    app: tauri::AppHandle,
    access: tauri::State<'_, Arc<FileAccess>>,
    path: String,
) -> Result<(), String> {
    guarded("Removing the recent file", async {
        access.forget_file(&path);
        crate::menu::refresh_recent_menu(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn clear_recent_files(
    app: tauri::AppHandle,
    access: tauri::State<'_, Arc<FileAccess>>,
) -> Result<(), String> {
    guarded("Clearing Recent Files", async {
        access.clear_recent();
        crate::menu::refresh_recent_menu(&app);
        Ok(())
    })
    .await
}

/// The files Finder, the Dock or `open -a` handed the app before the webview
/// was listening. Called once at startup; from then on `RunEvent::Opened`
/// emits them as `file-drop` (see `services::opened` and `lib.rs`).
#[tauri::command]
pub async fn take_pending_files(
    pending: tauri::State<'_, Arc<PendingOpen>>,
) -> Result<Vec<String>, String> {
    guarded("Reading the files to open", async { Ok(pending.take()) }).await
}

/// The bundled sample file (see `services::sample`), for the Welcome
/// screen's "Open sample file". The webview opens the path it gets back
/// through `open_parquet_file` like any other file, minus `remember_file`.
#[tauri::command]
pub async fn sample_file_path(app: tauri::AppHandle) -> Result<String, String> {
    guarded("Locating the sample file", async {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("The app's resource directory could not be found: {e}"))?;
        Ok(sample_path(&resource_dir)?.to_string_lossy().into_owned())
    })
    .await
}

/// Describe one directory entry for the explorer.
fn file_entry(entry: io::Result<DirEntry>) -> Result<FileEntry, String> {
    let entry = entry.map_err(|e| e.to_string())?;
    let metadata = entry.metadata().map_err(|e| e.to_string())?;
    let path = entry.path().to_string_lossy().into_owned();
    let is_directory = metadata.is_dir();
    Ok(FileEntry {
        is_parquet: !is_directory && has_parquet_extension(&path),
        size: (!is_directory).then_some(metadata.len()),
        path,
        name: entry.file_name().to_string_lossy().into_owned(),
        is_directory,
        children: None,
    })
}

/// The explorer's order: directories first, then files, each alphabetically
/// without regard to case.
fn explorer_order(a: &FileEntry, b: &FileEntry) -> Ordering {
    b.is_directory
        .cmp(&a.is_directory)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    guarded("Listing the folder", async { list_dir(&path) }).await
}

fn list_dir(path: &str) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(path);

    if !dir_path.exists() {
        return Err("Directory does not exist".to_string());
    }

    if !dir_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let mut entries = read_dir(dir_path)
        .map_err(|e| e.to_string())?
        .map(file_entry)
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(explorer_order);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::{has_parquet_extension, list_directory};
    use serde::Deserialize;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct ParquetExtensionCase {
        path: String,
        matches: bool,
    }

    fn parquet_extension_cases() -> Vec<ParquetExtensionCase> {
        serde_json::from_str(include_str!("../../../contracts/parquet-extension-cases.json"))
            .expect("the shared parquet-extension contract must be valid JSON")
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("parqsee-file-test-{}", std::process::id()))
            .join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn lists_directories_first_then_files_ignoring_case() {
        let dir = temp_dir("listing");
        std::fs::create_dir_all(dir.join("zeta")).unwrap();
        std::fs::create_dir_all(dir.join("Alpha")).unwrap();
        std::fs::write(dir.join("b.parquet"), b"xx").unwrap();
        std::fs::write(dir.join("A.PARQUET"), b"xxx").unwrap();
        std::fs::write(dir.join("c.csv"), b"x").unwrap();

        let entries = list_directory(dir.to_string_lossy().into_owned()).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "zeta", "A.PARQUET", "b.parquet", "c.csv"]);

        assert!(entries[0].is_directory);
        assert!(!entries[0].is_parquet);
        assert_eq!(entries[0].size, None);
        assert_eq!(entries[2].path, dir.join("A.PARQUET").to_string_lossy());
        assert!(entries[2].is_parquet);
        assert_eq!(entries[2].size, Some(3));
        assert!(!entries[4].is_parquet);
        assert_eq!(entries[4].size, Some(1));
        assert!(entries.iter().all(|e| e.children.is_none()));
    }

    #[tokio::test]
    async fn rejects_missing_paths_and_plain_files() {
        let dir = temp_dir("errors");
        std::fs::write(dir.join("file.txt"), b"x").unwrap();
        let missing = dir.join("missing").to_string_lossy().into_owned();
        assert_eq!(list_directory(missing).await.unwrap_err(), "Directory does not exist");
        let file = dir.join("file.txt").to_string_lossy().into_owned();
        assert_eq!(list_directory(file).await.unwrap_err(), "Path is not a directory");
    }

    #[test]
    fn follows_the_shared_parquet_extension_contract() {
        for case in parquet_extension_cases() {
            assert_eq!(has_parquet_extension(&case.path), case.matches, "{}", case.path);
        }
    }
}
