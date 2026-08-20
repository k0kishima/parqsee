use arrow::csv::Writer as CsvWriter;
use arrow::csv::WriterBuilder as CsvWriterBuilder;
use arrow::json::ArrayWriter as JsonArrayWriter;
use arrow::record_batch::RecordBatch;
use futures::StreamExt;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use std::fs::File;
use std::io::{BufWriter, Write};

use crate::services::parquet::{decimals_to_strings, ParquetCache};

/// Rows are decoded and written one batch at a time, so exports run in
/// constant memory regardless of how many rows are exported, and the
/// offset/limit are pushed into the parquet reader so a deep offset skips
/// row groups instead of decoding every row before it.
const EXPORT_BATCH_SIZE: usize = 8192;

/// A CSV or JSON destination that batches are streamed into.
enum RowWriter {
    Csv(CsvWriter<BufWriter<File>>),
    Json(JsonArrayWriter<BufWriter<File>>),
}

impl RowWriter {
    fn new(format: &str, mut out: BufWriter<File>) -> Result<Self, String> {
        match format.to_lowercase().as_str() {
            "csv" => {
                // UTF-8 BOM for Excel compatibility.
                out.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?;
                Ok(RowWriter::Csv(
                    CsvWriterBuilder::new()
                        .with_header(true)
                        .with_timestamp_format("%Y-%m-%d %H:%M:%S%.6f".to_string())
                        .build(out),
                ))
            }
            "json" => Ok(RowWriter::Json(JsonArrayWriter::new(out))),
            other => Err(format!("Unsupported export format: {}", other)),
        }
    }

    fn write(&mut self, batch: &RecordBatch) -> Result<usize, String> {
        match self {
            RowWriter::Csv(writer) => writer.write(batch).map_err(|e| e.to_string())?,
            // The JSON writer refuses decimals; the CSV writer handles them.
            RowWriter::Json(writer) => writer
                .write(&decimals_to_strings(batch)?)
                .map_err(|e| e.to_string())?,
        }
        Ok(batch.num_rows())
    }

    fn finish(self) -> Result<(), String> {
        match self {
            RowWriter::Csv(writer) => writer.into_inner().flush().map_err(|e| e.to_string()),
            RowWriter::Json(mut writer) => {
                writer.finish().map_err(|e| e.to_string())?;
                writer.into_inner().flush().map_err(|e| e.to_string())
            }
        }
    }
}

/// Export rows to `export_path`, returning how many rows were written.
///
/// `offset` and `limit` address rows of the *filtered* result, so the range
/// the user picks in the modal is the range they see in the grid.
pub async fn export_data(
    cache: &ParquetCache,
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
    filter: Option<String>,
) -> Result<usize, String> {
    let out = BufWriter::new(File::create(&export_path).map_err(|e| e.to_string())?);
    let writer = RowWriter::new(&format, out)?;

    match filter.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(filter) => export_filtered(cache, &source_path, filter, offset, limit, writer).await,
        None => export_range(&source_path, offset, limit, writer),
    }
}

/// Unfiltered: read straight from the parquet reader with the range pushed
/// down, so a deep offset skips row groups instead of decoding past them.
fn export_range(
    source_path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    mut writer: RowWriter,
) -> Result<usize, String> {
    let file = File::open(source_path).map_err(|e| e.to_string())?;
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

    let mut rows_written = 0usize;
    for batch in reader {
        rows_written += writer.write(&batch.map_err(|e| e.to_string())?)?;
    }
    writer.finish()?;
    Ok(rows_written)
}

/// Filtered: run the same WHERE clause the grid is showing and stream the
/// result batches out as they arrive.
async fn export_filtered(
    cache: &ParquetCache,
    source_path: &str,
    filter: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    mut writer: RowWriter,
) -> Result<usize, String> {
    let mut query = format!("SELECT * FROM t WHERE {}", filter);
    if let Some(limit) = limit {
        query.push_str(&format!(" LIMIT {}", limit));
    }
    if let Some(offset) = offset.filter(|o| *o > 0) {
        query.push_str(&format!(" OFFSET {}", offset));
    }

    let ctx = cache.get_or_create_session(source_path).await?;
    let df = ctx
        .sql(&query)
        .await
        .map_err(|e| format!("SQL execution failed: {}", e))?;
    let mut stream = df
        .execute_stream()
        .await
        .map_err(|e| format!("Failed to read filtered rows: {}", e))?;

    let mut rows_written = 0usize;
    while let Some(batch) = stream.next().await {
        rows_written += writer.write(&batch.map_err(|e| e.to_string())?)?;
    }
    writer.finish()?;
    Ok(rows_written)
}

#[cfg(test)]
mod tests {
    use super::export_data;
    use crate::services::parquet::ParquetCache;
    use arrow::array::{Decimal128Array, Float64Array, Int64Array, StringArray};
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

    #[tokio::test]
    async fn csv_keeps_columns_in_schema_order_and_honours_the_range() {
        let src = write_fixture();
        let out = temp_path("out.csv");
        let n = export_data(
            &ParquetCache::new(),
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "csv".into(),
            Some(1),
            Some(2),
            None,
        )
        .await
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

    #[tokio::test]
    async fn json_exports_decimal_columns_as_exact_strings() {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "amount",
            DataType::Decimal128(20, 4),
            false,
        )]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(
                Decimal128Array::from(vec![123456789i128])
                    .with_precision_and_scale(20, 4)
                    .unwrap(),
            )],
        )
        .unwrap();
        let src = temp_path("decimal.parquet");
        let mut writer = ArrowWriter::try_new(File::create(&src).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let out = temp_path("decimal.json");
        let n = export_data(
            &ParquetCache::new(),
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "json".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(parsed[0]["amount"], "12345.6789");
    }

    #[tokio::test]
    async fn a_filter_narrows_the_export_and_the_range_follows_it() {
        let src = write_fixture();
        let cache = ParquetCache::new();

        // id 2, 3 and 4 match; the range then addresses the filtered rows.
        let out = temp_path("filtered.csv");
        let n = export_data(
            &cache,
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "csv".into(),
            None,
            None,
            Some("\"id\" > 1".into()),
        )
        .await
        .unwrap();
        assert_eq!(n, 3);
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        assert_eq!(lines[0], "id,name,score");
        assert_eq!(lines.len(), 4);

        let out = temp_path("filtered_range.csv");
        let n = export_data(
            &cache,
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "csv".into(),
            Some(1),
            Some(1),
            Some("\"id\" > 1".into()),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        // The second row of the filtered result, not of the file.
        assert_eq!(lines[1], "3,\"c, d\",2.5");
    }

    #[tokio::test]
    async fn json_exports_all_rows_by_default() {
        let src = write_fixture();
        let out = temp_path("out.json");
        let n = export_data(
            &ParquetCache::new(),
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "json".into(),
            None,
            None,
            None,
        )
        .await
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
