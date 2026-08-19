use arrow::csv::WriterBuilder as CsvWriterBuilder;
use arrow::json::ArrayWriter as JsonArrayWriter;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use std::fs::File;
use std::io::{BufWriter, Write};

/// Rows are decoded and written one batch at a time, so exports run in
/// constant memory regardless of how many rows are exported, and the
/// offset/limit are pushed into the parquet reader so a deep offset skips
/// row groups instead of decoding every row before it.
const EXPORT_BATCH_SIZE: usize = 8192;

/// Export rows to `export_path`, returning how many rows were written.
pub fn export_data(
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<usize, String> {
    let file = File::open(&source_path).map_err(|e| e.to_string())?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)
        .map_err(|e| format!("Failed to open parquet file: {}", e))?;

    let total_rows = builder.metadata().file_metadata().num_rows() as usize;
    let offset = offset.unwrap_or(0).min(total_rows);
    let limit = limit.unwrap_or(total_rows - offset).min(total_rows - offset);

    let reader = builder
        .with_batch_size(EXPORT_BATCH_SIZE)
        .with_offset(offset)
        .with_limit(limit)
        .build()
        .map_err(|e| format!("Failed to read parquet file: {}", e))?;

    let out = File::create(&export_path).map_err(|e| e.to_string())?;
    let mut out = BufWriter::new(out);

    let mut rows_written = 0usize;
    match format.to_lowercase().as_str() {
        "csv" => {
            // UTF-8 BOM for Excel compatibility.
            out.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?;
            let mut writer = CsvWriterBuilder::new()
                .with_header(true)
                .with_timestamp_format("%Y-%m-%d %H:%M:%S%.6f".to_string())
                .build(out);
            for batch in reader {
                let batch = batch.map_err(|e| e.to_string())?;
                rows_written += batch.num_rows();
                writer.write(&batch).map_err(|e| e.to_string())?;
            }
            writer.into_inner().flush().map_err(|e| e.to_string())?;
        }
        "json" => {
            let mut writer = JsonArrayWriter::new(out);
            for batch in reader {
                let batch = batch.map_err(|e| e.to_string())?;
                rows_written += batch.num_rows();
                writer.write(&batch).map_err(|e| e.to_string())?;
            }
            writer.finish().map_err(|e| e.to_string())?;
            writer.into_inner().flush().map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unsupported export format: {}", format)),
    }

    Ok(rows_written)
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
