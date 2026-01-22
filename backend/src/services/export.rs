use csv::Writer;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::Row;
use std::fs::File;
use std::io::Write;

use crate::utils::{field_to_string, row_to_json};

pub fn export_data(
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

    Ok(format!(
        "Successfully exported {} rows to {}",
        rows_data.len(),
        export_path
    ))
}

fn export_to_csv(path: &str, columns: &[String], rows: &[Row]) -> Result<(), String> {
    let mut file = File::create(path).map_err(|e| e.to_string())?;

    // Write UTF-8 BOM for Excel compatibility
    file.write_all(&[0xEF, 0xBB, 0xBF])
        .map_err(|e| e.to_string())?;

    let mut writer = Writer::from_writer(file);

    // Write header
    writer.write_record(columns).map_err(|e| e.to_string())?;

    // Write data rows
    for row in rows {
        let mut record = Vec::new();
        for col_name in columns {
            let value = row
                .get_column_iter()
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
    let json_rows: Vec<serde_json::Value> = rows.iter().map(|row| row_to_json(row)).collect();

    let json_string = serde_json::to_string_pretty(&json_rows).map_err(|e| e.to_string())?;

    let mut file = File::create(path).map_err(|e| e.to_string())?;
    file.write_all(json_string.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(())
}
