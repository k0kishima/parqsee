use parquet::file::reader::{FileReader, SerializedFileReader};
use serde_json::Value;
use std::fs::File;

use crate::models::{ColumnInfo, ParquetMetadata};
use crate::utils::row_to_json;

pub fn get_metadata(path: &str) -> Result<ParquetMetadata, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
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
                    }
                    parquet::basic::LogicalType::Date => "DATE".to_string(),
                    parquet::basic::LogicalType::Time {
                        is_adjusted_to_u_t_c,
                        unit,
                    } => {
                        format!("TIME({:?}, UTC:{})", unit, is_adjusted_to_u_t_c)
                    }
                    parquet::basic::LogicalType::Timestamp {
                        is_adjusted_to_u_t_c,
                        unit,
                    } => {
                        format!("TIMESTAMP({:?}, UTC:{})", unit, is_adjusted_to_u_t_c)
                    }
                    parquet::basic::LogicalType::Integer {
                        bit_width,
                        is_signed,
                    } => {
                        format!(
                            "INT{}{}",
                            bit_width,
                            if is_signed { "" } else { "_UNSIGNED" }
                        )
                    }
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
                    parquet::basic::ConvertedType::TIMESTAMP_MILLIS => {
                        "TIMESTAMP_MILLIS".to_string()
                    }
                    parquet::basic::ConvertedType::TIMESTAMP_MICROS => {
                        "TIMESTAMP_MICROS".to_string()
                    }
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
                    }
                    parquet::basic::LogicalType::Date => "DATE".to_string(),
                    parquet::basic::LogicalType::Time {
                        is_adjusted_to_u_t_c,
                        unit,
                    } => {
                        format!("TIME({:?}, UTC:{})", unit, is_adjusted_to_u_t_c)
                    }
                    parquet::basic::LogicalType::Timestamp {
                        is_adjusted_to_u_t_c,
                        unit,
                    } => {
                        format!("TIMESTAMP({:?}, UTC:{})", unit, is_adjusted_to_u_t_c)
                    }
                    parquet::basic::LogicalType::Integer {
                        bit_width,
                        is_signed,
                    } => {
                        format!(
                            "INT{}{}",
                            bit_width,
                            if is_signed { "" } else { "_UNSIGNED" }
                        )
                    }
                    parquet::basic::LogicalType::Unknown => "UNKNOWN".to_string(),
                    parquet::basic::LogicalType::Json => "JSON".to_string(),
                    parquet::basic::LogicalType::Bson => "BSON".to_string(),
                    parquet::basic::LogicalType::Uuid => "UUID".to_string(),
                    parquet::basic::LogicalType::Float16 => "FLOAT16".to_string(),
                    parquet::basic::LogicalType::Variant => "VARIANT".to_string(),
                    parquet::basic::LogicalType::Geometry => "GEOMETRY".to_string(),
                    parquet::basic::LogicalType::Geography => "GEOGRAPHY".to_string(),
                })
            } else if field.get_basic_info().converted_type() != parquet::basic::ConvertedType::NONE
            {
                Some(match field.get_basic_info().converted_type() {
                    parquet::basic::ConvertedType::UTF8 => "STRING".to_string(),
                    parquet::basic::ConvertedType::MAP => "MAP".to_string(),
                    parquet::basic::ConvertedType::LIST => "LIST".to_string(),
                    parquet::basic::ConvertedType::ENUM => "ENUM".to_string(),
                    parquet::basic::ConvertedType::DECIMAL => "DECIMAL".to_string(),
                    parquet::basic::ConvertedType::DATE => "DATE".to_string(),
                    parquet::basic::ConvertedType::TIME_MILLIS => "TIME_MILLIS".to_string(),
                    parquet::basic::ConvertedType::TIME_MICROS => "TIME_MICROS".to_string(),
                    parquet::basic::ConvertedType::TIMESTAMP_MILLIS => {
                        "TIMESTAMP_MILLIS".to_string()
                    }
                    parquet::basic::ConvertedType::TIMESTAMP_MICROS => {
                        "TIMESTAMP_MICROS".to_string()
                    }
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
                column_type: logical_type
                    .clone()
                    .unwrap_or_else(|| physical_type.clone()),
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

pub fn read_data(path: &str, offset: usize, limit: usize) -> Result<Vec<Value>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
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
