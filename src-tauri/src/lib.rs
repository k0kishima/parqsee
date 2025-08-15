use serde::{Deserialize, Serialize};
use std::fs::{File, metadata, read_dir};
use std::path::Path;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::Row;
use base64::{Engine as _, engine::general_purpose};
use tauri::{Emitter, DragDropEvent};
use chrono::{NaiveDate, NaiveTime, DateTime};
use std::io::Write;
use csv::Writer;

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
    logical_type: Option<String>,
    physical_type: String,
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
        .map(|field| {
            // Get logical type if available, otherwise fall back to physical type
            let _type_str = if let Some(logical_type) = field.get_basic_info().logical_type() {
                match logical_type {
                    parquet::basic::LogicalType::String => "STRING".to_string(),
                    parquet::basic::LogicalType::Map => "MAP".to_string(),
                    parquet::basic::LogicalType::List => "LIST".to_string(),
                    parquet::basic::LogicalType::Enum => "ENUM".to_string(),
                    parquet::basic::LogicalType::Decimal { precision, scale } => {
                        format!("DECIMAL({},{})", precision, scale)
                    },
                    parquet::basic::LogicalType::Date => "DATE".to_string(),
                    parquet::basic::LogicalType::Time { is_adjusted_to_u_t_c, unit } => {
                        format!("TIME({:?}, UTC:{})", unit, is_adjusted_to_u_t_c)
                    },
                    parquet::basic::LogicalType::Timestamp { is_adjusted_to_u_t_c, unit } => {
                        format!("TIMESTAMP({:?}, UTC:{})", unit, is_adjusted_to_u_t_c)
                    },
                    parquet::basic::LogicalType::Integer { bit_width, is_signed } => {
                        format!("INT{}{}", bit_width, if is_signed { "" } else { "_UNSIGNED" })
                    },
                    parquet::basic::LogicalType::Unknown => "UNKNOWN".to_string(),
                    parquet::basic::LogicalType::Json => "JSON".to_string(),
                    parquet::basic::LogicalType::Bson => "BSON".to_string(),
                    parquet::basic::LogicalType::Uuid => "UUID".to_string(),
                    parquet::basic::LogicalType::Float16 => "FLOAT16".to_string(),
                    parquet::basic::LogicalType::Variant => "VARIANT".to_string(),
                    parquet::basic::LogicalType::Geometry => "GEOMETRY".to_string(),
                    parquet::basic::LogicalType::Geography => "GEOGRAPHY".to_string(),
                }
            } else {
                // Check converted type for older Parquet files or fall back to physical type
                let converted_type = field.get_basic_info().converted_type();
                match converted_type {
                    parquet::basic::ConvertedType::UTF8 => "STRING".to_string(),
                    parquet::basic::ConvertedType::MAP => "MAP".to_string(),
                    parquet::basic::ConvertedType::LIST => "LIST".to_string(),
                    parquet::basic::ConvertedType::ENUM => "ENUM".to_string(),
                    parquet::basic::ConvertedType::DECIMAL => "DECIMAL".to_string(),
                    parquet::basic::ConvertedType::DATE => "DATE".to_string(),
                    parquet::basic::ConvertedType::TIME_MILLIS => "TIME_MILLIS".to_string(),
                    parquet::basic::ConvertedType::TIME_MICROS => "TIME_MICROS".to_string(),
                    parquet::basic::ConvertedType::TIMESTAMP_MILLIS => "TIMESTAMP_MILLIS".to_string(),
                    parquet::basic::ConvertedType::TIMESTAMP_MICROS => "TIMESTAMP_MICROS".to_string(),
                    parquet::basic::ConvertedType::UINT_8 => "UINT8".to_string(),
                    parquet::basic::ConvertedType::UINT_16 => "UINT16".to_string(),
                    parquet::basic::ConvertedType::UINT_32 => "UINT32".to_string(),
                    parquet::basic::ConvertedType::UINT_64 => "UINT64".to_string(),
                    parquet::basic::ConvertedType::INT_8 => "INT8".to_string(),
                    parquet::basic::ConvertedType::INT_16 => "INT16".to_string(),
                    parquet::basic::ConvertedType::INT_32 => "INT32".to_string(),
                    parquet::basic::ConvertedType::INT_64 => "INT64".to_string(),
                    parquet::basic::ConvertedType::JSON => "JSON".to_string(),
                    parquet::basic::ConvertedType::BSON => "BSON".to_string(),
                    parquet::basic::ConvertedType::INTERVAL => "INTERVAL".to_string(),
                    parquet::basic::ConvertedType::MAP_KEY_VALUE => "MAP_KEY_VALUE".to_string(),
                    parquet::basic::ConvertedType::NONE => {
                        // Fall back to physical type
                        format!("{:?}", field.get_physical_type())
                    }
                }
            };
            
            let physical_type = format!("{:?}", field.get_physical_type());
            let logical_type = if let Some(logical_type) = field.get_basic_info().logical_type() {
                Some(match logical_type {
                    parquet::basic::LogicalType::String => "STRING".to_string(),
                    parquet::basic::LogicalType::Map => "MAP".to_string(),
                    parquet::basic::LogicalType::List => "LIST".to_string(),
                    parquet::basic::LogicalType::Enum => "ENUM".to_string(),
                    parquet::basic::LogicalType::Decimal { precision, scale } => {
                        format!("DECIMAL({},{})", precision, scale)
                    },
                    parquet::basic::LogicalType::Date => "DATE".to_string(),
                    parquet::basic::LogicalType::Time { is_adjusted_to_u_t_c, unit } => {
                        format!("TIME({:?}, UTC:{})", unit, is_adjusted_to_u_t_c)
                    },
                    parquet::basic::LogicalType::Timestamp { is_adjusted_to_u_t_c, unit } => {
                        format!("TIMESTAMP({:?}, UTC:{})", unit, is_adjusted_to_u_t_c)
                    },
                    parquet::basic::LogicalType::Integer { bit_width, is_signed } => {
                        format!("INT{}{}", bit_width, if is_signed { "" } else { "_UNSIGNED" })
                    },
                    parquet::basic::LogicalType::Unknown => "UNKNOWN".to_string(),
                    parquet::basic::LogicalType::Json => "JSON".to_string(),
                    parquet::basic::LogicalType::Bson => "BSON".to_string(),
                    parquet::basic::LogicalType::Uuid => "UUID".to_string(),
                    parquet::basic::LogicalType::Float16 => "FLOAT16".to_string(),
                    parquet::basic::LogicalType::Variant => "VARIANT".to_string(),
                    parquet::basic::LogicalType::Geometry => "GEOMETRY".to_string(),
                    parquet::basic::LogicalType::Geography => "GEOGRAPHY".to_string(),
                })
            } else if field.get_basic_info().converted_type() != parquet::basic::ConvertedType::NONE {
                Some(match field.get_basic_info().converted_type() {
                    parquet::basic::ConvertedType::UTF8 => "STRING".to_string(),
                    parquet::basic::ConvertedType::MAP => "MAP".to_string(),
                    parquet::basic::ConvertedType::LIST => "LIST".to_string(),
                    parquet::basic::ConvertedType::ENUM => "ENUM".to_string(),
                    parquet::basic::ConvertedType::DECIMAL => "DECIMAL".to_string(),
                    parquet::basic::ConvertedType::DATE => "DATE".to_string(),
                    parquet::basic::ConvertedType::TIME_MILLIS => "TIME_MILLIS".to_string(),
                    parquet::basic::ConvertedType::TIME_MICROS => "TIME_MICROS".to_string(),
                    parquet::basic::ConvertedType::TIMESTAMP_MILLIS => "TIMESTAMP_MILLIS".to_string(),
                    parquet::basic::ConvertedType::TIMESTAMP_MICROS => "TIMESTAMP_MICROS".to_string(),
                    parquet::basic::ConvertedType::UINT_8 => "UINT8".to_string(),
                    parquet::basic::ConvertedType::UINT_16 => "UINT16".to_string(),
                    parquet::basic::ConvertedType::UINT_32 => "UINT32".to_string(),
                    parquet::basic::ConvertedType::UINT_64 => "UINT64".to_string(),
                    parquet::basic::ConvertedType::INT_8 => "INT8".to_string(),
                    parquet::basic::ConvertedType::INT_16 => "INT16".to_string(),
                    parquet::basic::ConvertedType::INT_32 => "INT32".to_string(),
                    parquet::basic::ConvertedType::INT_64 => "INT64".to_string(),
                    parquet::basic::ConvertedType::JSON => "JSON".to_string(),
                    parquet::basic::ConvertedType::BSON => "BSON".to_string(),
                    parquet::basic::ConvertedType::INTERVAL => "INTERVAL".to_string(),
                    parquet::basic::ConvertedType::MAP_KEY_VALUE => "MAP_KEY_VALUE".to_string(),
                    parquet::basic::ConvertedType::NONE => unreachable!(),
                })
            } else {
                None
            };
            
            ColumnInfo {
                name: field.name().to_string(),
                column_type: logical_type.clone().unwrap_or_else(|| physical_type.clone()),
                logical_type,
                physical_type,
            }
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
            parquet::record::Field::UByte(v) => serde_json::Value::Number((*v).into()),
            parquet::record::Field::UShort(v) => serde_json::Value::Number((*v).into()),
            parquet::record::Field::UInt(v) => serde_json::Value::Number((*v).into()),
            parquet::record::Field::ULong(v) => serde_json::Value::Number((*v).into()),
            parquet::record::Field::Float(v) => serde_json::Value::Number(
                serde_json::Number::from_f64(*v as f64).unwrap_or(serde_json::Number::from(0))
            ),
            parquet::record::Field::Double(v) => serde_json::Value::Number(
                serde_json::Number::from_f64(*v).unwrap_or(serde_json::Number::from(0))
            ),
            parquet::record::Field::Decimal(d) => {
                // Convert decimal to string for accurate representation
                serde_json::Value::String(format!("{:?}", d))
            },
            parquet::record::Field::Str(v) => serde_json::Value::String(v.clone()),
            parquet::record::Field::Bytes(v) => serde_json::Value::String(
                general_purpose::STANDARD.encode(v.data())
            ),
            parquet::record::Field::Date(v) => {
                // Date is days since Unix epoch (1970-01-01)
                let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
                let date = epoch + chrono::Duration::days(*v as i64);
                serde_json::Value::String(date.format("%Y-%m-%d").to_string())
            },
            parquet::record::Field::TimestampMillis(v) => {
                // Timestamp in milliseconds since Unix epoch
                let seconds = v / 1000;
                let nanos = ((v % 1000) * 1_000_000) as u32;
                if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                    serde_json::Value::String(dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
                } else {
                    serde_json::Value::Number((*v).into())
                }
            },
            parquet::record::Field::TimestampMicros(v) => {
                // Timestamp in microseconds since Unix epoch
                let seconds = v / 1_000_000;
                let nanos = ((v % 1_000_000) * 1000) as u32;
                if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                    serde_json::Value::String(dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string())
                } else {
                    serde_json::Value::Number((*v).into())
                }
            },
            parquet::record::Field::TimeMillis(v) => {
                // Time in milliseconds since midnight
                let hours = v / (60 * 60 * 1000);
                let minutes = (v % (60 * 60 * 1000)) / (60 * 1000);
                let seconds = (v % (60 * 1000)) / 1000;
                let millis = v % 1000;
                if let Some(time) = NaiveTime::from_hms_milli_opt(hours as u32, minutes as u32, seconds as u32, millis as u32) {
                    serde_json::Value::String(time.format("%H:%M:%S%.3f").to_string())
                } else {
                    serde_json::Value::Number((*v).into())
                }
            },
            parquet::record::Field::TimeMicros(v) => {
                // Time in microseconds since midnight
                let hours = v / (60 * 60 * 1_000_000);
                let minutes = (v % (60 * 60 * 1_000_000)) / (60 * 1_000_000);
                let seconds = (v % (60 * 1_000_000)) / 1_000_000;
                let micros = v % 1_000_000;
                if let Some(time) = NaiveTime::from_hms_micro_opt(hours as u32, minutes as u32, seconds as u32, micros as u32) {
                    serde_json::Value::String(time.format("%H:%M:%S%.6f").to_string())
                } else {
                    serde_json::Value::Number((*v).into())
                }
            },
            parquet::record::Field::Float16(v) => {
                // Convert f16 to f64 for JSON
                serde_json::Value::Number(
                    serde_json::Number::from_f64(v.to_f64()).unwrap_or(serde_json::Number::from(0))
                )
            },
            parquet::record::Field::Group(g) => {
                // Handle nested groups recursively
                row_to_json(g)
            },
            parquet::record::Field::ListInternal(list) => {
                // Handle lists
                let items: Vec<serde_json::Value> = list.elements()
                    .iter()
                    .map(|field| field_to_json(field))
                    .collect();
                serde_json::Value::Array(items)
            },
            parquet::record::Field::MapInternal(map_field) => {
                // Handle maps
                let mut json_map = serde_json::Map::new();
                for (k, v) in map_field.entries() {
                    json_map.insert(field_to_json(k).to_string(), field_to_json(v));
                }
                serde_json::Value::Object(json_map)
            },
            parquet::record::Field::Null => serde_json::Value::Null,
        };
        
        map.insert(name.clone(), json_value);
    }
    
    serde_json::Value::Object(map)
}

fn field_to_json(field: &parquet::record::Field) -> serde_json::Value {
    match field {
        parquet::record::Field::Bool(v) => serde_json::Value::Bool(*v),
        parquet::record::Field::Byte(v) => serde_json::Value::Number((*v).into()),
        parquet::record::Field::Short(v) => serde_json::Value::Number((*v).into()),
        parquet::record::Field::Int(v) => serde_json::Value::Number((*v).into()),
        parquet::record::Field::Long(v) => serde_json::Value::Number((*v).into()),
        parquet::record::Field::UByte(v) => serde_json::Value::Number((*v).into()),
        parquet::record::Field::UShort(v) => serde_json::Value::Number((*v).into()),
        parquet::record::Field::UInt(v) => serde_json::Value::Number((*v).into()),
        parquet::record::Field::ULong(v) => serde_json::Value::Number((*v).into()),
        parquet::record::Field::Float(v) => serde_json::Value::Number(
            serde_json::Number::from_f64(*v as f64).unwrap_or(serde_json::Number::from(0))
        ),
        parquet::record::Field::Double(v) => serde_json::Value::Number(
            serde_json::Number::from_f64(*v).unwrap_or(serde_json::Number::from(0))
        ),
        parquet::record::Field::Decimal(d) => serde_json::Value::String(format!("{:?}", d)),
        parquet::record::Field::Str(v) => serde_json::Value::String(v.clone()),
        parquet::record::Field::Bytes(v) => serde_json::Value::String(
            general_purpose::STANDARD.encode(v.data())
        ),
        parquet::record::Field::Date(v) => {
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
            let date = epoch + chrono::Duration::days(*v as i64);
            serde_json::Value::String(date.format("%Y-%m-%d").to_string())
        },
        parquet::record::Field::TimestampMillis(v) => {
            let seconds = v / 1000;
            let nanos = ((v % 1000) * 1_000_000) as u32;
            if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                serde_json::Value::String(dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
            } else {
                serde_json::Value::Number((*v).into())
            }
        },
        parquet::record::Field::TimestampMicros(v) => {
            let seconds = v / 1_000_000;
            let nanos = ((v % 1_000_000) * 1000) as u32;
            if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                serde_json::Value::String(dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string())
            } else {
                serde_json::Value::Number((*v).into())
            }
        },
        parquet::record::Field::TimeMillis(v) => {
            let hours = v / (60 * 60 * 1000);
            let minutes = (v % (60 * 60 * 1000)) / (60 * 1000);
            let seconds = (v % (60 * 1000)) / 1000;
            let millis = v % 1000;
            if let Some(time) = NaiveTime::from_hms_milli_opt(hours as u32, minutes as u32, seconds as u32, millis as u32) {
                serde_json::Value::String(time.format("%H:%M:%S%.3f").to_string())
            } else {
                serde_json::Value::Number((*v).into())
            }
        },
        parquet::record::Field::TimeMicros(v) => {
            let hours = v / (60 * 60 * 1_000_000);
            let minutes = (v % (60 * 60 * 1_000_000)) / (60 * 1_000_000);
            let seconds = (v % (60 * 1_000_000)) / 1_000_000;
            let micros = v % 1_000_000;
            if let Some(time) = NaiveTime::from_hms_micro_opt(hours as u32, minutes as u32, seconds as u32, micros as u32) {
                serde_json::Value::String(time.format("%H:%M:%S%.6f").to_string())
            } else {
                serde_json::Value::Number((*v).into())
            }
        },
        parquet::record::Field::Float16(v) => serde_json::Value::Number(
            serde_json::Number::from_f64(v.to_f64()).unwrap_or(serde_json::Number::from(0))
        ),
        parquet::record::Field::Group(g) => row_to_json(g),
        parquet::record::Field::ListInternal(list) => {
            let items: Vec<serde_json::Value> = list.elements()
                .iter()
                .map(|f| field_to_json(f))
                .collect();
            serde_json::Value::Array(items)
        },
        parquet::record::Field::MapInternal(map_field) => {
            let mut json_map = serde_json::Map::new();
            for (k, v) in map_field.entries() {
                json_map.insert(field_to_json(k).to_string(), field_to_json(v));
            }
            serde_json::Value::Object(json_map)
        },
        parquet::record::Field::Null => serde_json::Value::Null,
    }
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
async fn check_file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
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

#[tauri::command]
async fn export_data(
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<String, String> {
    // Read parquet file
    let file = File::open(&source_path).map_err(|e| e.to_string())?;
    let reader = SerializedFileReader::new(file).map_err(|e| e.to_string())?;
    
    let metadata = reader.metadata();
    let schema = metadata.file_metadata().schema();
    let total_rows = metadata.file_metadata().num_rows() as usize;
    
    // Get column names
    let columns: Vec<String> = schema
        .get_fields()
        .iter()
        .map(|field| field.name().to_string())
        .collect();
    
    let mut iter = reader.get_row_iter(None).map_err(|e| e.to_string())?;
    
    // Skip to offset if provided
    let offset = offset.unwrap_or(0);
    for _ in 0..offset {
        if iter.next().is_none() {
            break;
        }
    }
    
    // Determine how many rows to export
    let limit = limit.unwrap_or(total_rows - offset);
    let rows_to_export = limit.min(total_rows - offset);
    
    // Collect data
    let mut rows_data = Vec::new();
    for _ in 0..rows_to_export {
        match iter.next() {
            Some(Ok(row)) => {
                rows_data.push(row);
            }
            Some(Err(e)) => return Err(e.to_string()),
            None => break,
        }
    }
    
    // Export based on format
    match format.to_lowercase().as_str() {
        "csv" => export_to_csv(&export_path, &columns, &rows_data),
        "json" => export_to_json(&export_path, &rows_data),
        _ => Err(format!("Unsupported export format: {}", format)),
    }?;
    
    Ok(format!("Successfully exported {} rows to {}", rows_data.len(), export_path))
}

fn export_to_csv(path: &str, columns: &[String], rows: &[Row]) -> Result<(), String> {
    let mut file = File::create(path).map_err(|e| e.to_string())?;
    
    // Write UTF-8 BOM for Excel compatibility
    file.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?;
    
    let mut writer = Writer::from_writer(file);
    
    // Write header
    writer.write_record(columns).map_err(|e| e.to_string())?;
    
    // Write data rows
    for row in rows {
        let mut record = Vec::new();
        for col_name in columns {
            let value = row.get_column_iter()
                .find(|(name, _)| *name == col_name)
                .map(|(_, field)| field_to_string(field))
                .unwrap_or_else(|| "".to_string());
            record.push(value);
        }
        writer.write_record(&record).map_err(|e| e.to_string())?;
    }
    
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn export_to_json(path: &str, rows: &[Row]) -> Result<(), String> {
    let json_rows: Vec<serde_json::Value> = rows.iter()
        .map(|row| row_to_json(row))
        .collect();
    
    let json_string = serde_json::to_string_pretty(&json_rows)
        .map_err(|e| e.to_string())?;
    
    let mut file = File::create(path).map_err(|e| e.to_string())?;
    file.write_all(json_string.as_bytes()).map_err(|e| e.to_string())?;
    
    Ok(())
}


fn field_to_string(field: &parquet::record::Field) -> String {
    match field {
        parquet::record::Field::Bool(v) => v.to_string(),
        parquet::record::Field::Byte(v) => v.to_string(),
        parquet::record::Field::Short(v) => v.to_string(),
        parquet::record::Field::Int(v) => v.to_string(),
        parquet::record::Field::Long(v) => v.to_string(),
        parquet::record::Field::UByte(v) => v.to_string(),
        parquet::record::Field::UShort(v) => v.to_string(),
        parquet::record::Field::UInt(v) => v.to_string(),
        parquet::record::Field::ULong(v) => v.to_string(),
        parquet::record::Field::Float(v) => v.to_string(),
        parquet::record::Field::Double(v) => v.to_string(),
        parquet::record::Field::Decimal(d) => format!("{:?}", d),
        parquet::record::Field::Str(v) => v.clone(),
        parquet::record::Field::Bytes(v) => general_purpose::STANDARD.encode(v.data()),
        parquet::record::Field::Date(v) => {
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
            let date = epoch + chrono::Duration::days(*v as i64);
            date.format("%Y-%m-%d").to_string()
        },
        parquet::record::Field::TimestampMillis(v) => {
            let seconds = v / 1000;
            let nanos = ((v % 1000) * 1_000_000) as u32;
            if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
            } else {
                v.to_string()
            }
        },
        parquet::record::Field::TimestampMicros(v) => {
            let seconds = v / 1_000_000;
            let nanos = ((v % 1_000_000) * 1000) as u32;
            if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
            } else {
                v.to_string()
            }
        },
        parquet::record::Field::TimeMillis(v) => {
            let hours = v / (60 * 60 * 1000);
            let minutes = (v % (60 * 60 * 1000)) / (60 * 1000);
            let seconds = (v % (60 * 1000)) / 1000;
            let millis = v % 1000;
            if let Some(time) = NaiveTime::from_hms_milli_opt(hours as u32, minutes as u32, seconds as u32, millis as u32) {
                time.format("%H:%M:%S%.3f").to_string()
            } else {
                v.to_string()
            }
        },
        parquet::record::Field::TimeMicros(v) => {
            let hours = v / (60 * 60 * 1_000_000);
            let minutes = (v % (60 * 60 * 1_000_000)) / (60 * 1_000_000);
            let seconds = (v % (60 * 1_000_000)) / 1_000_000;
            let micros = v % 1_000_000;
            if let Some(time) = NaiveTime::from_hms_micro_opt(hours as u32, minutes as u32, seconds as u32, micros as u32) {
                time.format("%H:%M:%S%.6f").to_string()
            } else {
                v.to_string()
            }
        },
        parquet::record::Field::Float16(v) => v.to_f64().to_string(),
        parquet::record::Field::Group(_) => "[GROUP]".to_string(),
        parquet::record::Field::ListInternal(_) => "[LIST]".to_string(),
        parquet::record::Field::MapInternal(_) => "[MAP]".to_string(),
        parquet::record::Field::Null => "".to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![open_parquet_file, read_parquet_data, get_file_info, list_directory, check_file_exists, export_data])
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