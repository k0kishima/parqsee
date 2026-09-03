use arrow::csv::Writer as CsvWriter;
use arrow::csv::WriterBuilder as CsvWriterBuilder;
use arrow::json::ArrayWriter as JsonArrayWriter;
use arrow::record_batch::RecordBatch;
use futures::StreamExt;
use std::fs::File;
use std::io::{BufWriter, Write};

use crate::services::parquet::{
    build_page_query, json_unsafe_to_strings, nested_to_json_strings, range_reader, where_clause, ParquetCache,
};

/// Rows are decoded and written one batch at a time, so exports run in
/// constant memory regardless of how many rows are exported, and the
/// offset/limit are pushed into the parquet reader so a deep offset skips
/// row groups instead of decoding every row before it.
const EXPORT_BATCH_SIZE: usize = 8192;

#[derive(Clone, Copy)]
enum ExportFormat {
    Csv,
    Json,
}

impl ExportFormat {
    fn parse(format: &str) -> Result<Self, String> {
        match format.to_lowercase().as_str() {
            "csv" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            other => Err(format!("Unsupported export format: {}", other)),
        }
    }
}

/// A CSV or JSON destination that batches are streamed into.
enum RowWriter {
    Csv(CsvWriter<BufWriter<File>>),
    Json(JsonArrayWriter<BufWriter<File>>),
}

impl RowWriter {
    /// Create the staging file and wrap it for `format`. Callers validate the
    /// source and the query *before* this, so a doomed export never gets as
    /// far as touching the filesystem.
    fn create(format: ExportFormat, path: &str) -> Result<Self, String> {
        let mut out = BufWriter::new(
            File::create(path).map_err(|e| format!("Cannot write {}: {}", path, e))?,
        );
        match format {
            ExportFormat::Csv => {
                // UTF-8 BOM for Excel compatibility.
                out.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?;
                Ok(RowWriter::Csv(
                    CsvWriterBuilder::new()
                        .with_header(true)
                        .with_timestamp_format("%Y-%m-%d %H:%M:%S%.6f".to_string())
                        .build(out),
                ))
            }
            ExportFormat::Json => Ok(RowWriter::Json(JsonArrayWriter::new(out))),
        }
    }

    fn write(&mut self, batch: &RecordBatch) -> Result<usize, String> {
        match self {
            // The CSV writer refuses nested columns; JSON text keeps them readable.
            RowWriter::Csv(writer) => writer
                .write(&nested_to_json_strings(batch)?)
                .map_err(|e| e.to_string())?,
            // The JSON writer refuses decimals and nulls out NaN; the CSV
            // writer handles both.
            RowWriter::Json(writer) => writer
                .write(&json_unsafe_to_strings(batch)?)
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
///
/// The rows are written to a staging file next to the destination and only
/// moved into place once the export has finished, so a failed export — bad
/// format, missing source, rejected filter, or an error mid-write — never
/// destroys an existing file at `export_path`.
pub async fn export_data(
    cache: &ParquetCache,
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
    filter: Option<String>,
) -> Result<usize, String> {
    let format = ExportFormat::parse(&format)?;
    let staging_path = format!("{}.partial", export_path);

    let result = match where_clause(filter.as_deref()) {
        Some(filter) => {
            export_filtered(cache, &source_path, filter, offset, limit, format, &staging_path).await
        }
        None => {
            // Decode and write on the blocking pool: a multi-GB export must
            // not hold an async worker, or concurrent page reads would stall
            // behind it.
            let staging = staging_path.clone();
            tokio::task::spawn_blocking(move || {
                export_range(&source_path, offset, limit, format, &staging)
            })
            .await
            .map_err(|e| format!("Export task failed: {}", e))?
        }
    };

    match result {
        Ok(rows_written) => {
            std::fs::rename(&staging_path, &export_path)
                .map_err(|e| format!("Failed to move the export into place at {}: {}", export_path, e))?;
            Ok(rows_written)
        }
        Err(err) => {
            // Nothing may have been created yet; ignore a missing staging file.
            let _ = std::fs::remove_file(&staging_path);
            Err(err)
        }
    }
}

/// Unfiltered: read straight from the parquet reader with the range pushed
/// down (`range_reader`), the same path the grid's unfiltered pages take.
fn export_range(
    source_path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    format: ExportFormat,
    staging_path: &str,
) -> Result<usize, String> {
    let reader = range_reader(source_path, offset, limit, EXPORT_BATCH_SIZE)?;

    let mut writer = RowWriter::create(format, staging_path)?;
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
    format: ExportFormat,
    staging_path: &str,
) -> Result<usize, String> {
    let query = build_page_query(Some(filter), offset, limit);

    // Planning rejects a bad filter here, before any file is created.
    let ctx = cache.get_or_create_session(source_path).await?;
    let df = ctx
        .sql(&query)
        .await
        .map_err(|e| format!("SQL execution failed: {}", e))?;

    let mut stream = df
        .execute_stream()
        .await
        .map_err(|e| format!("Failed to read filtered rows: {}", e))?;

    // The file writes are synchronous, so they run on the blocking pool and
    // batches cross over a small bounded channel — memory stays constant and
    // the async workers stay free for concurrent page reads. The writer task
    // is always joined, so the staging file is never touched after this
    // function returns.
    let staging = staging_path.to_string();
    let (tx, rx) = std::sync::mpsc::sync_channel::<RecordBatch>(4);
    let writer_task = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let mut writer = RowWriter::create(format, &staging)?;
        let mut rows_written = 0usize;
        for batch in rx {
            rows_written += writer.write(&batch)?;
        }
        writer.finish()?;
        Ok(rows_written)
    });

    let mut stream_error: Option<String> = None;
    while let Some(batch) = stream.next().await {
        match batch {
            // A send fails only when the writer died; its error surfaces below.
            Ok(batch) => {
                if tx.send(batch).is_err() {
                    break;
                }
            }
            Err(e) => {
                stream_error = Some(e.to_string());
                break;
            }
        }
    }
    drop(tx);

    let written = writer_task
        .await
        .map_err(|e| format!("Export task failed: {}", e))?;
    match stream_error {
        Some(e) => Err(e),
        None => written,
    }
}

#[cfg(test)]
mod tests {
    use super::export_data;
    use crate::services::parquet::ParquetCache;
    use arrow::array::{
        ArrayRef, Decimal128Array, Float64Array, Int64Array, ListBuilder, StringArray, StringBuilder,
    };
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
    async fn csv_exports_nested_columns_as_json_text() {
        let item = Arc::new(Field::new("item", DataType::Utf8, true));
        let mut tags = ListBuilder::new(StringBuilder::new());
        tags.values().append_value("a");
        tags.values().append_value("b");
        tags.append(true);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "tags",
            DataType::List(item),
            true,
        )]));
        let batch =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(tags.finish()) as ArrayRef]).unwrap();
        let src = temp_path("nested.parquet");
        let mut writer = ArrowWriter::try_new(File::create(&src).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let out = temp_path("nested.csv");
        let n = export_data(
            &ParquetCache::new(),
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "csv".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(n, 1);
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        assert_eq!(lines[0], "tags");
        assert_eq!(lines[1], r#""[""a"",""b""]""#);
    }

    #[tokio::test]
    async fn a_failed_export_leaves_an_existing_destination_untouched() {
        let src = write_fixture();
        let out = temp_path("precious.csv");
        std::fs::write(&out, "previous good export").unwrap();

        // A filter the planner rejects.
        let err = export_data(
            &ParquetCache::new(),
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "csv".into(),
            None,
            None,
            Some("\"no_such_column\" = 1".into()),
        )
        .await
        .unwrap_err();
        assert!(err.contains("SQL execution failed"), "unexpected error: {err}");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "previous good export");

        // A source that does not exist.
        export_data(
            &ParquetCache::new(),
            temp_path("missing.parquet").to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "csv".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "previous good export");

        // An unsupported format.
        export_data(
            &ParquetCache::new(),
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "xlsx".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "previous good export");

        // No staging leftovers either.
        assert!(!temp_path("precious.csv.partial").exists());
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
