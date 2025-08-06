use serde::{Deserialize, Serialize};
use std::fs::{File, metadata, read_dir};
use std::path::Path;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::Row;
use base64::{Engine as _, engine::general_purpose};
use tauri::{Emitter, DragDropEvent};

#[derive(Debug, Serialize, Deserialize)]
struct ParquetMetadata {
    num_rows: i64,
    num_columns: usize,
    columns: Vec<ColumnInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ColumnInfo {
    name: String,
    column_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileEntry {
    path: String,
    name: String,
    is_directory: bool,
    is_parquet: bool,
    size: Option<u64>,
    children: Option<Vec<FileEntry>>,
}

#[tauri::command]
async fn open_parquet_file(path: String) -> Result<ParquetMetadata, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = SerializedFileReader::new(file).map_err(|e| e.to_string())?;
    
    let metadata = reader.metadata();
    let schema = metadata.file_metadata().schema();
    
    let columns: Vec<ColumnInfo> = schema
        .get_fields()
        .iter()
        .map(|field| ColumnInfo {
            name: field.name().to_string(),
            column_type: format!("{:?}", field.get_physical_type()),
        })
        .collect();
    
    Ok(ParquetMetadata {
        num_rows: metadata.file_metadata().num_rows(),
        num_columns: columns.len(),
        columns,
    })
}

#[tauri::command]
async fn read_parquet_data(path: String, offset: usize, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = SerializedFileReader::new(file).map_err(|e| e.to_string())?;
    
    let mut iter = reader.get_row_iter(None).map_err(|e| e.to_string())?;
    
    // Skip to offset
    for _ in 0..offset {
        if iter.next().is_none() {
            break;
        }
    }
    
    // Read limited rows
    let mut rows = Vec::new();
    for _ in 0..limit {
        match iter.next() {
            Some(Ok(row)) => {
                let json_value = row_to_json(&row);
                rows.push(json_value);
            }
            Some(Err(e)) => return Err(e.to_string()),
            None => break,
        }
    }
    
    Ok(rows)
}

fn row_to_json(row: &Row) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    
    for (name, value) in row.get_column_iter() {
        let json_value = match value {
            parquet::record::Field::Bool(v) => serde_json::Value::Bool(*v),
            parquet::record::Field::Byte(v) => serde_json::Value::Number((*v).into()),
            parquet::record::Field::Short(v) => serde_json::Value::Number((*v).into()),
            parquet::record::Field::Int(v) => serde_json::Value::Number((*v).into()),
            parquet::record::Field::Long(v) => serde_json::Value::Number((*v).into()),
            parquet::record::Field::Float(v) => serde_json::Value::Number(
                serde_json::Number::from_f64(*v as f64).unwrap_or(serde_json::Number::from(0))
            ),
            parquet::record::Field::Double(v) => serde_json::Value::Number(
                serde_json::Number::from_f64(*v).unwrap_or(serde_json::Number::from(0))
            ),
            parquet::record::Field::Str(v) => serde_json::Value::String(v.clone()),
            parquet::record::Field::Bytes(v) => serde_json::Value::String(
                general_purpose::STANDARD.encode(v.data())
            ),
            parquet::record::Field::Null => serde_json::Value::Null,
            _ => serde_json::Value::Null,
        };
        
        map.insert(name.clone(), json_value);
    }
    
    serde_json::Value::Object(map)
}

#[tauri::command]
async fn get_file_info(path: String) -> Result<FileInfo, String> {
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
async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
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
        let size = if is_directory { None } else { Some(metadata.len()) };
        
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
    entries.sort_by(|a, b| {
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    
    Ok(entries)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![open_parquet_file, read_parquet_data, get_file_info, list_directory])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    println!("Files dropped: {:?}", paths);
                    // Send event to frontend
                    window.emit("file-drop", paths).unwrap();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}