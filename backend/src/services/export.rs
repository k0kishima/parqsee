use csv::Writer;
use parquet::file::reader::FileReader;
use parquet::record::Row;
use std::fs::File;
use std::io::Write;

use crate::services::parquet::open_file_reader;
use crate::utils::{field_to_string, row_to_json};

/// Export rows to `export_path`, returning how many rows were written.
pub fn export_data(
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<usize, String> {
    // Read parquet file
    let reader = open_file_reader(&source_path)?;

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

    Ok(rows_data.len())
}

fn export_to_csv(path: &str, columns: &[String], rows: &[Row]) -> Result<(), String> {
    let mut file = File::create(path).map_err(|e| e.to_string())?;

    // Write UTF-8 BOM for Excel compatibility
    file.write_all(&[0xEF, 0xBB, 0xBF])
        .map_err(|e| e.to_string())?;

    let mut writer = Writer::from_writer(file);

    // Write header
    writer.write_record(columns).map_err(|e| e.to_string())?;

    // Write data rows. A Row carries every top-level field in schema order,
    // which is the order `columns` was built in, so no per-cell lookup by
    // name is needed (that was quadratic in the column count).
    for row in rows {
        let record: Vec<String> = row
            .get_column_iter()
            .map(|(_, field)| field_to_string(field))
            .collect();
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

#[cfg(test)]
mod tests {
    use super::export_data;
    use arrow::array::{Float64Array, Int64Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use std::fs::File;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("parqsee-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// Three columns, four rows, one null, written in schema order id, name, score.
    fn write_fixture() -> PathBuf {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("score", DataType::Float64, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
                Arc::new(StringArray::from(vec![Some("a"), None, Some("c, d"), Some("e")])),
                Arc::new(Float64Array::from(vec![0.5, 1.5, 2.5, 3.5])),
            ],
        )
        .unwrap();
        let path = temp_path("fixture.parquet");
        let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
        path
    }

    #[test]
    fn csv_keeps_columns_in_schema_order_and_honours_the_range() {
        let src = write_fixture();
        let out = temp_path("out.csv");
        let n = export_data(
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "csv".into(),
            Some(1),
            Some(2),
        )
        .unwrap();
        assert_eq!(n, 2);
        let text = std::fs::read_to_string(&out).unwrap();
        let text = text.trim_start_matches('\u{feff}');
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "id,name,score");
        assert_eq!(lines[1], "2,,1.5");
        assert_eq!(lines[2], "3,\"c, d\",2.5");
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn json_exports_all_rows_by_default() {
        let src = write_fixture();
        let out = temp_path("out.json");
        let n = export_data(
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "json".into(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(n, 4);
        let parsed: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        let rows = parsed.as_array().unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0]["id"], 1);
        assert_eq!(rows[0]["name"], "a");
        assert!(rows[1]["name"].is_null());
        assert_eq!(rows[3]["score"], 3.5);
    }
}
