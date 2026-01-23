use parquet::file::reader::{FileReader, SerializedFileReader};
use serde_json::Value;
use std::fs::File;

use crate::models::{ColumnInfo, ParquetMetadata};

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

use arrow::json::LineDelimitedWriter;
use datafusion::prelude::*;

// ... (existing get_metadata)

pub async fn read_data(
    path: &str,
    offset: usize,
    limit: usize,
    filter: Option<String>,
) -> Result<Vec<Value>, String> {
    // Create DataFusion context
    let ctx = SessionContext::new();

    // Register the parquet file as a table named "t"
    let options = ParquetReadOptions::default();
    ctx.register_parquet("t", path, options)
        .await
        .map_err(|e| format!("Failed to register parquet file: {}", e))?;

    // Construct query
    let where_clause = if let Some(f) = filter {
        if !f.trim().is_empty() {
            format!("WHERE {}", f)
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let query = format!(
        "SELECT * FROM t {} LIMIT {} OFFSET {}",
        where_clause, limit, offset
    );

    // Execute the query
    let df = ctx
        .sql(&query)
        .await
        .map_err(|e| format!("Query execution failed: {}", e))?;

    // Collect results
    let batches = df
        .collect()
        .await
        .map_err(|e| format!("Failed to collect results: {}", e))?;

    // Convert to JSON using LineDelimitedWriter
    let mut buf = Vec::new();
    {
        let mut writer = LineDelimitedWriter::new(&mut buf);
        for batch in &batches {
            writer
                .write(batch)
                .map_err(|e| format!("Failed to write batch: {}", e))?;
        }
        writer
            .finish()
            .map_err(|e| format!("Failed to finish writing: {}", e))?;
    }

    // Parse lines back to JSON objects
    let rows: Result<Vec<Value>, _> = serde_json::Deserializer::from_slice(&buf)
        .into_iter::<Value>()
        .collect();

    rows.map_err(|e| format!("Failed to parse JSON results: {}", e))
}

pub async fn count_data(path: &str, filter: Option<String>) -> Result<usize, String> {
    // Create DataFusion context
    let ctx = SessionContext::new();

    // Register the parquet file as a table named "t"
    let options = ParquetReadOptions::default();
    ctx.register_parquet("t", path, options)
        .await
        .map_err(|e| format!("Failed to register parquet file: {}", e))?;

    // Construct query
    let where_clause = if let Some(f) = filter {
        if !f.trim().is_empty() {
            format!("WHERE {}", f)
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let query = format!("SELECT COUNT(*) FROM t {}", where_clause);

    // Execute the query
    let df = ctx
        .sql(&query)
        .await
        .map_err(|e| format!("Query execution failed: {}", e))?;

    // Collect results
    let batches = df
        .collect()
        .await
        .map_err(|e| format!("Failed to collect results: {}", e))?;

    if batches.is_empty() {
        return Ok(0);
    }

    // Extract count from the first batch
    let batch = &batches[0];
    if batch.num_rows() == 0 {
        return Ok(0);
    }

    let column = batch.column(0);
    let count = column
        .as_any()
        .downcast_ref::<arrow::array::Int64Array>()
        .ok_or_else(|| "Failed to downcast count result".to_string())?
        .value(0);

    Ok(count as usize)
}
