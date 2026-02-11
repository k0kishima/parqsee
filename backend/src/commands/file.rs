use crate::models::{FileEntry, FileInfo, ParquetMetadata};
use crate::services::parquet::ParquetCache;
use std::fs::{metadata, read_dir};
use std::path::Path;

#[tauri::command]
pub async fn open_parquet_file(
    cache: tauri::State<'_, ParquetCache>,
    path: String,
) -> Result<ParquetMetadata, String> {
    cache.get_or_create_metadata(&path)
}

#[tauri::command]
pub async fn get_file_info(path: String) -> Result<FileInfo, String> {
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
}

#[tauri::command]
pub async fn check_file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(&path);

    if !dir_path.exists() {
        return Err("Directory does not exist".to_string());
    }

    if !dir_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let mut entries = Vec::new();

    let read_result = read_dir(dir_path).map_err(|e| e.to_string())?;

    for entry in read_result {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();

        let file_name = entry.file_name().to_string_lossy().to_string();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;

        let is_directory = metadata.is_dir();
        let is_parquet = !is_directory && path_str.ends_with(".parquet");
        let size = if is_directory {
            None
        } else {
            Some(metadata.len())
        };

        entries.push(FileEntry {
            path: path_str,
            name: file_name,
            is_directory,
            is_parquet,
            size,
            children: None,
        });
    }

    // Sort: directories first, then files, alphabetically
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}
