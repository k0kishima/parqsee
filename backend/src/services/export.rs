use arrow::csv::Writer as CsvWriter;
use arrow::csv::WriterBuilder as CsvWriterBuilder;
use arrow::json::ArrayWriter as JsonArrayWriter;
use arrow::record_batch::RecordBatch;
use futures::StreamExt;
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use crate::models::SortSpec;
use crate::services::parquet::{
    build_page_query, build_sorted_query, is_memory_exhausted, json_unsafe_to_strings,
    nested_to_json_strings, sort_order, SortOrder,
    plan_query_checked, range_reader, sorted_page_batches, where_clause, ParquetCache, ResultCachePolicy,
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
    // Boxed: the CSV writer is several times the size of the JSON one
    // (clippy::large_enum_variant).
    Csv(Box<CsvWriter<BufWriter<File>>>),
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
                Ok(RowWriter::Csv(Box::new(
                    CsvWriterBuilder::new()
                        .with_header(true)
                        .with_timestamp_format("%Y-%m-%d %H:%M:%S%.6f".to_string())
                        .build(out),
                )))
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
/// The rows are written to a staging file and only moved into place once
/// the export has finished, so a failed export — bad format, missing
/// source, rejected filter, or an error mid-write — never destroys an
/// existing file at `export_path`. The staging file lives in the process's
/// temp directory, not next to the destination: under the App Sandbox the
/// save panel grants exactly the file the user chose, so creating a sibling
/// `<name>.partial` there is refused (EPERM) unless the folder happens to be
/// inside an open workspace root, while the temp directory (the container's
/// `Data/tmp` in the sandboxed build) can always be written. The move itself
/// is `move_into_place`, which keeps the same promise when it has to copy.
#[allow(clippy::too_many_arguments)]
pub async fn export_data(
    cache: &ParquetCache,
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
    filter: Option<String>,
    sort: Option<SortSpec>,
) -> Result<usize, String> {
    export_data_with(
        &RealFs,
        cache,
        source_path,
        export_path,
        format,
        offset,
        limit,
        filter,
        sort,
    )
        .await
}

/// `export_data` with the finalisation's filesystem calls taken from `fs`;
/// the tests hand in one that refuses the rename and fails the copy halfway.
#[allow(clippy::too_many_arguments)]
async fn export_data_with(
    fs: &dyn FinalizeFs,
    cache: &ParquetCache,
    source_path: String,
    export_path: String,
    format: String,
    offset: Option<usize>,
    limit: Option<usize>,
    filter: Option<String>,
    sort: Option<SortSpec>,
) -> Result<usize, String> {
    let format = ExportFormat::parse(&format)?;
    // Before anything is created: a file replaced under the tab would be
    // written out through the schema the session registered, giving the old
    // header over the new file's rows.
    cache.check_unchanged(&source_path)?;
    let staging_path = staging_path_for(&export_path).to_string_lossy().into_owned();

    // Resolving the sort needs the file's columns; a sort by a column the
    // file no longer has is refused here, before any file is created.
    let order_by = match sort.as_ref() {
        Some(sort) => {
            let metadata = cache.get_or_create_metadata(&source_path).await?;
            Some(sort_order(sort, &metadata.columns)?)
        }
        None => None,
    };

    let result = match (where_clause(filter.as_deref()), order_by) {
        // Small sorted ranges (including current pages) share the grid's
        // mirrored window. Reuse existing results without evicting grid pages
        // to cache custom export ranges. Larger ranges and full exports stream.
        (_, Some(_)) if limit.is_some_and(|n| n <= EXPORT_BATCH_SIZE) => {
            let batches = sorted_page_batches(
                cache, &source_path, offset.unwrap_or(0), limit.unwrap(),
                filter, sort.expect("ORDER BY requires a sort"),
                ResultCachePolicy::ReuseOnly,
            ).await.map_err(|e| {
                if is_memory_exhausted(&e) {
                    "This sorted export needs more memory than the app allows. Export a smaller \
                     range or narrow the rows with a filter.".to_string()
                } else {
                    e
                }
            })?;
            let staging = staging_path.clone();
            tokio::task::spawn_blocking(move || {
                let mut writer = RowWriter::create(format, &staging)?;
                let mut rows = 0;
                for batch in batches {
                    rows += writer.write(&batch)?;
                }
                writer.finish()?;
                Ok(rows)
            }).await.map_err(|e| format!("Export task failed: {}", e))?
        }
        (None, None) => {
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
        (filter, order_by) => {
            export_query(
                cache,
                &source_path,
                filter,
                order_by.as_ref(),
                offset,
                limit,
                format,
                &staging_path,
            )
                .await
        }
    };

    match result {
        Ok(rows_written) => {
            move_into_place(fs, Path::new(&staging_path), Path::new(&export_path))?;
            Ok(rows_written)
        }
        Err(err) => {
            // Nothing may have been created yet; ignore a missing staging file.
            let _ = std::fs::remove_file(&staging_path);
            Err(err)
        }
    }
}

/// A unique staging path in the temp directory for an export to `export_path`
/// (`<name>.<pid>.<nanos>.partial`, so two exports of files with the same name
/// cannot collide).
fn staging_path_for(export_path: &str) -> PathBuf {
    let name = Path::new(export_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "export".to_string());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
            .unwrap_or(0);
    std::env::temp_dir().join(format!("{name}.{}.{nanos}.partial", std::process::id()))
}

/// The filesystem calls `move_into_place` makes, behind a trait so a test can
/// refuse the rename — the only way onto the copy fallback within one volume
/// — and fail a read or a write partway through, which no real file does on
/// demand. `RealFs` is the one the app uses.
trait FinalizeFs: Sync {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn open(&self, path: &Path) -> io::Result<Box<dyn Read>>;
    /// Create `path`, truncating it when it exists (`File::create`).
    fn create(&self, path: &Path) -> io::Result<Box<dyn Write>>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
}

struct RealFs;

impl FinalizeFs for RealFs {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }
    fn open(&self, path: &Path) -> io::Result<Box<dyn Read>> {
        Ok(Box::new(File::open(path)?))
    }
    fn create(&self, path: &Path) -> io::Result<Box<dyn Write>> {
        Ok(Box::new(File::create(path)?))
    }
    fn remove_file(&self, path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
    }
}

const COPY_BUFFER_SIZE: usize = 1 << 20;

/// Why a copy failed: before the destination was opened, so nothing was
/// touched, or after it was, so it may hold part of the source.
enum CopyError {
    Create(io::Error),
    Write(io::Error),
}

impl From<CopyError> for io::Error {
    fn from(err: CopyError) -> Self {
        match err {
            CopyError::Create(e) | CopyError::Write(e) => e,
        }
    }
}

/// Stream `from` into `to`, created or truncated. `from` is opened before
/// `to` is created, so an unreadable source leaves `to` untouched — as does
/// a destination that cannot be created, which is why the two are told
/// apart from a write that failed once `to` was open and truncated.
fn copy_bytes(fs: &dyn FinalizeFs, from: &Path, to: &Path) -> Result<(), CopyError> {
    let mut reader = fs.open(from).map_err(CopyError::Create)?;
    let mut writer = fs.create(to).map_err(CopyError::Create)?;
    let mut buf = vec![0u8; COPY_BUFFER_SIZE];
    loop {
        let n = reader.read(&mut buf).map_err(CopyError::Write)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(CopyError::Write)?;
    }
    writer.flush().map_err(CopyError::Write)
}

/// Move the finished staging file to `export_path`. A `rename` is atomic and
/// free on the same volume. When it is refused — the destination is on
/// another volume, or the sandbox lets the app write the granted file but
/// not link a new entry into its folder — the rows are copied into the
/// granted path instead, and that copy cannot be atomic: the save panel
/// grants exactly the chosen file, so there is nowhere beside it to stage a
/// replacement, and the file has to be truncated before the first byte is
/// written. So the previous contents are copied to a backup in the temp
/// directory first, and a copy that fails partway — the volume filled up, an
/// I/O error — puts them back before the error is returned; a destination
/// that did not exist is removed again. A copy that could not open the
/// destination at all — the folder refuses the write, so `File::create`
/// fails before a byte is written — has damaged nothing, so the backup and
/// the staging file are cleaned up and the error says the file was left as
/// it was; putting contents back that were never taken away would only
/// fail the same way and report damage that did not happen. When the backup
/// itself cannot be made, the destination is not touched at all. Only a
/// restore that fails
/// too leaves the destination damaged; the backup and the complete export
/// are then kept in the temp directory and named in the error, so nothing
/// is lost. The staging file is consumed on success and removed on every
/// other outcome.
fn move_into_place(fs: &dyn FinalizeFs, staging: &Path, export_path: &Path) -> Result<(), String> {
    if fs.rename(staging, export_path).is_ok() {
        return Ok(());
    }
    let dest = export_path.display();
    let backup = staging.with_extension("backup");

    let previous = match copy_bytes(fs, export_path, &backup) {
        Ok(()) => true,
        Err(CopyError::Create(e)) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => {
            let e = io::Error::from(e);
            let _ = fs.remove_file(&backup);
            let _ = fs.remove_file(staging);
            return Err(format!(
                "Failed to move the export into place at {dest}: \
                 the existing file could not be backed up first ({e}), so it was left as it was"
            ));
        }
    };

    let copy_err = match copy_bytes(fs, staging, export_path) {
        Ok(()) => {
            let _ = fs.remove_file(staging);
            let _ = fs.remove_file(&backup);
            return Ok(());
        }
        // The destination was never opened, so it holds whatever it held.
        Err(CopyError::Create(e)) => {
            let _ = fs.remove_file(staging);
            let _ = fs.remove_file(&backup);
            return Err(format!(
                "Failed to move the export into place at {dest}: {e}; the file was left as it was"
            ));
        }
        Err(CopyError::Write(e)) => e,
    };

    let restored = if previous {
        copy_bytes(fs, &backup, export_path).map_err(io::Error::from)
    } else {
        match fs.remove_file(export_path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    };
    match restored {
        Ok(()) => {
            let _ = fs.remove_file(staging);
            let _ = fs.remove_file(&backup);
            let outcome = if previous {
                "the previous file was left as it was"
            } else {
                "nothing was left there"
            };
            Err(format!("Failed to move the export into place at {dest}: {copy_err}; {outcome}"))
        }
        Err(restore_err) if previous => Err(format!(
            "Failed to move the export into place at {dest}: {copy_err}, \
             and its previous contents could not be put back ({restore_err}); \
             they are kept at {} and the complete export at {}",
            backup.display(),
            staging.display()
        )),
        Err(restore_err) => Err(format!(
            "Failed to move the export into place at {dest}: {copy_err}, \
             and the partial file could not be removed ({restore_err}); \
             the complete export is kept at {}",
            staging.display()
        )),
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

/// Filtered or sorted: run the same `WHERE` clause and `ORDER BY` the grid
/// is showing and stream the result batches out as they arrive.
#[allow(clippy::too_many_arguments)]
async fn export_query(
    cache: &ParquetCache,
    source_path: &str,
    filter: Option<&str>,
    order: Option<&SortOrder>,
    offset: Option<usize>,
    limit: Option<usize>,
    format: ExportFormat,
    staging_path: &str,
) -> Result<usize, String> {
    let query = match order {
        Some(order) => build_sorted_query(filter, order, offset, limit),
        None => build_page_query(filter, offset, limit),
    };

    // Planning rejects a bad filter here, before any file is created, and
    // refuses a filter that would change the session the browse grid shares
    // (see `plan_query_checked`) rather than only failing to parse.
    let ctx = cache.get_or_create_session(source_path).await?;
    let plan = plan_query_checked(&ctx, &query).await?;
    let df = ctx
        .execute_logical_plan(plan)
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
    use super::{export_data, export_data_with, staging_path_for, FinalizeFs, RealFs};
    use crate::models::{SortDirection, SortSpec};
    use crate::services::parquet::ParquetCache;
    use arrow::array::{
        Array, ArrayRef, Decimal128Array, DictionaryArray, Float64Array, Int32Array, Int64Array,
        ListBuilder, StringArray, StringBuilder,
    };
    use arrow::datatypes::{DataType, Field, Int32Type, Schema};
    use arrow::record_batch::RecordBatch;
    use std::collections::VecDeque;
    use std::io::{self, Read, Write};
    use std::path::{Path, PathBuf};
    use crate::services::test_support::{self, write_parquet};
    use std::sync::{Arc, Mutex};

    fn temp_path(name: &str) -> PathBuf {
        test_support::temp_path("export", name)
    }

    /// Staging and backup files for an export named `name` that are still in
    /// the temp directory — there must be none once `export_data` has
    /// returned, except when the destination could not be put back.
    fn staging_leftovers(name: &str) -> Vec<PathBuf> {
        std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                let file = p.file_name().unwrap().to_string_lossy().into_owned();
                file.starts_with(&format!("{name}."))
                    && (file.ends_with(".partial") || file.ends_with(".backup"))
            })
            .collect()
    }

    /// Reads or writes at most `remaining` bytes through, then fails, the way
    /// a volume that filled up or a failing disk would partway through a copy.
    struct FailAfter<T> {
        inner: T,
        remaining: usize,
    }

    fn injected(what: &str) -> io::Error {
        io::Error::other(format!("injected {what} failure"))
    }

    impl<R: Read> Read for FailAfter<R> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(injected("read"));
            }
            let n = buf.len().min(self.remaining);
            let n = self.inner.read(&mut buf[..n])?;
            self.remaining -= n;
            Ok(n)
        }
    }

    impl<W: Write> Write for FailAfter<W> {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(injected("write"));
            }
            let n = buf.len().min(self.remaining);
            let n = self.inner.write(&buf[..n])?;
            self.remaining -= n;
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.inner.flush()
        }
    }

    /// The real filesystem, except that the rename is refused — which is what
    /// another volume or the sandbox does, and the only way onto the copy
    /// fallback — and that chosen paths cannot be opened or created at all,
    /// or fail partway through a read or a write. The files themselves are
    /// real, so a failed write really does leave the destination truncated
    /// and half written, as `File::create` would.
    #[derive(Default)]
    struct ScriptedFs {
        /// Opening this path fails as an unreadable file would.
        unreadable: Option<PathBuf>,
        /// Reads of the staging file (`.partial`; its name is minted inside
        /// the export) fail after this many bytes.
        staging_read_limit: Option<usize>,
        /// Creating this path fails before a byte is written, the way a
        /// folder the app may not write into refuses `File::create`.
        refuse_create: Option<PathBuf>,
        /// Each successive create of this path fails after that many bytes
        /// written; once the list is used up, creates are unlimited.
        write_limits: Option<(PathBuf, Mutex<VecDeque<usize>>)>,
    }

    impl ScriptedFs {
        fn write_limits(mut self, path: &Path, limits: &[usize]) -> Self {
            self.write_limits = Some((path.to_path_buf(), Mutex::new(limits.iter().copied().collect())));
            self
        }
    }

    impl FinalizeFs for ScriptedFs {
        fn rename(&self, _from: &Path, _to: &Path) -> io::Result<()> {
            Err(io::Error::other("injected cross-device link"))
        }
        fn open(&self, path: &Path) -> io::Result<Box<dyn Read>> {
            if self.unreadable.as_deref() == Some(path) {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected unreadable"));
            }
            let inner = RealFs.open(path)?;
            let is_staging = path.extension().is_some_and(|ext| ext == "partial");
            Ok(match self.staging_read_limit {
                Some(remaining) if is_staging => Box::new(FailAfter { inner, remaining }),
                _ => inner,
            })
        }
        fn create(&self, path: &Path) -> io::Result<Box<dyn Write>> {
            if self.refuse_create.as_deref() == Some(path) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected refused create",
                ));
            }
            let limit = match &self.write_limits {
                Some((limited, limits)) if limited == path => limits.lock().unwrap().pop_front(),
                _ => None,
            };
            let inner = RealFs.create(path)?;
            Ok(match limit {
                Some(remaining) => Box::new(FailAfter { inner, remaining }),
                None => inner,
            })
        }
        fn remove_file(&self, path: &Path) -> io::Result<()> {
            RealFs.remove_file(path)
        }
    }

    /// Export the four-row fixture `name` to `out` over `fs`, as CSV.
    async fn export_over(fs: &dyn FinalizeFs, name: &str, out: &Path) -> Result<usize, String> {
        let src = write_fixture(name);
        export_data_with(
            fs,
            &ParquetCache::new(),
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            "csv".into(),
            None,
            None,
            None,
            None,
        )
            .await
    }

    /// [`export_data`] with paths as paths and the range as one argument.
    ///
    /// The command takes owned strings and eight positional arguments, of
    /// which most tests below have to write four `None`s that say nothing
    /// about what the test is for. Offset and limit become one `range`
    /// because the grid never asks for one without the other.
    async fn export(
        cache: &ParquetCache,
        src: &Path,
        out: &Path,
        format: &str,
        range: Option<(usize, usize)>,
        filter: Option<&str>,
        sort: Option<SortSpec>,
    ) -> Result<usize, String> {
        export_data(
            cache,
            src.to_string_lossy().into_owned(),
            out.to_string_lossy().into_owned(),
            format.into(),
            range.map(|(offset, _)| offset),
            range.map(|(_, limit)| limit),
            filter.map(Into::into),
            sort,
        )
            .await
    }

    /// What the four-row fixture exports as, produced by the rename path.
    async fn expected_csv(name: &str) -> Vec<u8> {
        let out = temp_path(&format!("{name}_reference.csv"));
        export_over(&RealFs, name, &out).await.unwrap();
        std::fs::read(&out).unwrap()
    }

    const PREVIOUS: &[u8] = b"previous good export\n";

    /// Three columns, four rows, one null, written in schema order id, name, score.
    /// `name` keeps the file apart per test: the tests run in parallel, and
    /// two of them writing the same fixture path raced each other.
    fn write_fixture(name: &str) -> PathBuf {
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
        let path = temp_path(&format!("{name}.parquet"));
        write_parquet(&path, &batch, None);
        path
    }

    /// An export of a file replaced under the tab wrote the old schema's
    /// header over the new file's rows — `id,name` with every `name` empty,
    /// and no error anywhere. The destination is left untouched instead.
    #[tokio::test]
    async fn an_export_after_the_file_was_rewritten_is_refused() {
        let src = write_fixture("rewritten_export");
        let out = temp_path("rewritten_export.csv");
        let _ = std::fs::remove_file(&out);
        let cache = ParquetCache::new();
        cache
            .get_or_create_metadata(&src.to_string_lossy())
            .await
            .unwrap();

        let replacement = RecordBatch::try_from_iter(vec![(
            "other",
            Arc::new(Int64Array::from(vec![7, 8])) as ArrayRef,
        )])
        .unwrap();
        test_support::rewrite_parquet(&src, &replacement);

        let err = export(&cache, &src, &out, "csv", None, None, None)
            .await
            .unwrap_err();
        assert!(err.contains("Refresh"), "{err}");
        assert!(!out.exists(), "a refused export must create no file");
        assert!(staging_leftovers("rewritten_export").is_empty());
    }

    #[tokio::test]
    async fn csv_keeps_columns_in_schema_order_and_honours_the_range() {
        let src = write_fixture("csv_range");
        let out = temp_path("out.csv");
        let n = export(&ParquetCache::new(), &src, &out, "csv", Some((1, 2)), None, None)
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
        write_parquet(&src, &batch, None);

        let out = temp_path("decimal.json");
        let n = export(&ParquetCache::new(), &src, &out, "json", None, None, None)
            .await
            .unwrap();
        assert_eq!(n, 1);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(parsed[0]["amount"], "12345.6789");
    }

    #[tokio::test]
    async fn dictionary_floats_export_as_json_strings() {
        // What pandas' categorical and pyarrow's `dictionary_encode()` write:
        // the values JSON cannot spell are behind a dictionary encoding.
        let values = Arc::new(Float64Array::from(vec![1.5, f64::NAN, f64::INFINITY])) as ArrayRef;
        let keys = Int32Array::from(vec![Some(0), Some(1), Some(2), None]);
        let dictionary = DictionaryArray::<Int32Type>::try_new(keys, values).unwrap();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "dfloat",
            dictionary.data_type().clone(),
            true,
        )]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(dictionary) as ArrayRef]).unwrap();
        let src = temp_path("dictionary_float.parquet");
        write_parquet(&src, &batch, None);

        let out = temp_path("dictionary_float.json");
        let n = export(&ParquetCache::new(), &src, &out, "json", None, None, None)
            .await
            .unwrap();
        assert_eq!(n, 4);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(parsed[0]["dfloat"], "1.5");
        assert_eq!(parsed[1]["dfloat"], "NaN");
        assert_eq!(parsed[2]["dfloat"], "Infinity");
        assert!(parsed[3].get("dfloat").is_none());
    }

    #[tokio::test]
    async fn a_filter_narrows_the_export_and_the_range_follows_it() {
        let src = write_fixture("filtered");
        let cache = ParquetCache::new();

        // id 2, 3 and 4 match; the range then addresses the filtered rows.
        let out = temp_path("filtered.csv");
        let n = export(&cache, &src, &out, "csv", None, Some("\"id\" > 1"), None)
            .await
            .unwrap();
        assert_eq!(n, 3);
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        assert_eq!(lines[0], "id,name,score");
        assert_eq!(lines.len(), 4);

        let out = temp_path("filtered_range.csv");
        let n = export(&cache, &src, &out, "csv", Some((1, 1)), Some("\"id\" > 1"), None)
            .await
            .unwrap();
        assert_eq!(n, 1);
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        // The second row of the filtered result, not of the file.
        assert_eq!(lines[1], "3,\"c, d\",2.5");
    }

    /// A sorted export walks the sequence the sorted grid paginates over,
    /// and a range addresses that sequence: exporting "the current page" of
    /// a sorted grid writes the rows on screen.
    #[tokio::test]
    async fn a_sorted_export_writes_the_rows_in_the_grids_order() {
        let src = write_fixture("sorted");
        let cache = ParquetCache::new();
        let by_name_desc = || {
            Some(SortSpec {
                column: "name".into(),
                direction: SortDirection::Desc,
            })
        };

        // name DESC NULLS FIRST: the null, then e, "c, d", a.
        let out = temp_path("sorted.csv");
        let n = export(&cache, &src, &out, "csv", None, None, by_name_desc())
            .await
            .unwrap();
        assert_eq!(n, 4);
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        assert_eq!(lines, ["id,name,score", "2,,1.5", "4,e,3.5", "3,\"c, d\",2.5", "1,a,0.5"]);

        // The second and third rows of the sorted result, with a filter on top.
        let out = temp_path("sorted_range.csv");
        let n = export(&cache, &src, &out, "csv", Some((1, 2)), Some("\"id\" > 1"), by_name_desc())
            .await
            .unwrap();
        assert_eq!(n, 2);
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        assert_eq!(lines, ["id,name,score", "4,e,3.5", "3,\"c, d\",2.5"]);

        // A sort by a column the file does not have is refused before any
        // file is created.
        let out = temp_path("sorted_missing.csv");
        let err = export(&cache, &src, &out, "csv", None, None, Some(SortSpec { column: "gone".into(), direction: SortDirection::Asc }))
            .await
            .unwrap_err();
        assert!(err.contains("gone"), "{err}");
        assert!(!out.exists());
    }

    #[tokio::test]
    async fn a_sorted_range_memory_error_has_export_specific_guidance() {
        let src = write_fixture("sort_export_memory");
        let out = temp_path("sort_export_memory.csv");
        let cache = ParquetCache::new().with_memory_limit(1);
        let err = export(&cache, &src, &out, "csv", Some((1, 1)), None, Some(SortSpec { column: "name".into(), direction: SortDirection::Asc })).await.unwrap_err();
        assert!(err.contains("sorted export"), "{err}");
        assert!(!err.contains("SQL view"), "{err}");
        assert!(!out.exists());
    }

    #[tokio::test]
    async fn sorted_page_exports_match_slices_of_the_full_export() {
        let src = write_fixture("sorted_windows");
        let cache = ParquetCache::new();
        for direction in [SortDirection::Asc, SortDirection::Desc] {
            for filter in [None, Some("id > 1".to_string())] {
                let sort = Some(SortSpec { column: "name".into(), direction });
                let full = temp_path("sorted_full.json");
                export(&cache, &src, &full, "json", None, filter.as_deref(), sort.clone()).await.unwrap();
                let expected: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(&full).unwrap()).unwrap();
                for (offset, limit) in [(0, 2), (2, 1), (3, 10), (4, 2), (0, 0)] {
                    let out = temp_path("sorted_page.json");
                    let n = export(&cache, &src, &out, "json", Some((offset, limit)), filter.as_deref(), sort.clone()).await.unwrap();
                    let actual: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
                    let want = expected.iter().skip(offset).take(limit).cloned().collect::<Vec<_>>();
                    assert_eq!(actual, want, "{direction:?} {filter:?} offset={offset} limit={limit}");
                    assert_eq!(n, want.len());
                }
            }
        }
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
        write_parquet(&src, &batch, None);

        let out = temp_path("nested.csv");
        let n = export(&ParquetCache::new(), &src, &out, "csv", None, None, None)
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
        let src = write_fixture("precious");
        let out = temp_path("precious.csv");
        std::fs::write(&out, "previous good export").unwrap();

        // A filter the planner rejects.
        let err = export(&ParquetCache::new(), &src, &out, "csv", None, Some("\"no_such_column\" = 1"), None)
            .await
            .unwrap_err();
        assert!(err.contains("SQL execution failed"), "unexpected error: {err}");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "previous good export");

        // A source that does not exist.
        export(&ParquetCache::new(), &temp_path("missing.parquet"), &out, "csv", None, None, None)
            .await
            .unwrap_err();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "previous good export");

        // An unsupported format.
        export(&ParquetCache::new(), &src, &out, "xlsx", None, None, None)
            .await
            .unwrap_err();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "previous good export");

        // No staging leftovers either — not next to the destination, which the
        // sandboxed build may not write, and not in the temp directory.
        assert!(!temp_path("precious.csv.partial").exists());
        assert!(staging_leftovers("precious.csv").is_empty());
    }

    #[tokio::test]
    async fn the_staging_file_never_touches_the_destination_folder() {
        // Under the App Sandbox the save panel grants exactly the chosen file,
        // so the export must not create anything else in its folder.
        let src = write_fixture("granted");
        let dir = temp_path("granted_dir");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("granted.csv");

        let rows = export(&ParquetCache::new(), &src, &out, "csv", None, None, None)
            .await
            .unwrap();
        assert_eq!(rows, 4);

        let entries: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["granted.csv".to_string()], "only the granted file may exist");
        assert!(staging_leftovers("granted.csv").is_empty());
        assert!(!staging_path_for(out.to_str().unwrap()).starts_with(&dir));
    }

    #[tokio::test]
    async fn json_exports_all_rows_by_default() {
        let src = write_fixture("json_all");
        let out = temp_path("out.json");
        let n = export(&ParquetCache::new(), &src, &out, "json", None, None, None)
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

    #[tokio::test]
    async fn a_refused_rename_copies_the_export_into_the_granted_file() {
        // Another volume, or the sandbox's grant on the chosen file alone.
        let out = temp_path("copied.csv");
        std::fs::write(&out, PREVIOUS).unwrap();

        let n = export_over(&ScriptedFs::default(), "copied", &out).await.unwrap();
        assert_eq!(n, 4);
        assert_eq!(std::fs::read(&out).unwrap(), expected_csv("copied").await);
        assert!(staging_leftovers("copied.csv").is_empty());
    }

    #[tokio::test]
    async fn a_copy_that_fails_partway_puts_the_previous_file_back() {
        let out = temp_path("restored.csv");
        std::fs::write(&out, PREVIOUS).unwrap();

        let fs = ScriptedFs::default().write_limits(&out, &[10]);
        let err = export_over(&fs, "restored", &out).await.unwrap_err();
        assert!(
            err.starts_with("Failed to move the export into place at")
                && err.contains("injected write failure")
                && err.ends_with("the previous file was left as it was"),
            "unexpected error: {err}"
        );
        assert_eq!(std::fs::read(&out).unwrap(), PREVIOUS);
        assert!(staging_leftovers("restored.csv").is_empty());
    }

    #[tokio::test]
    async fn a_copy_that_fails_partway_onto_a_new_file_removes_it_again() {
        let out = temp_path("fresh.csv");
        let _ = std::fs::remove_file(&out);

        let fs = ScriptedFs::default().write_limits(&out, &[10]);
        let err = export_over(&fs, "fresh", &out).await.unwrap_err();
        assert!(err.ends_with("nothing was left there"), "unexpected error: {err}");
        assert!(!out.exists(), "a half-written file must not be left behind");
        assert!(staging_leftovers("fresh.csv").is_empty());
    }

    #[tokio::test]
    async fn a_staging_file_that_cannot_be_read_through_puts_the_previous_file_back() {
        let out = temp_path("unreadable_staging.csv");
        std::fs::write(&out, PREVIOUS).unwrap();

        let fs = ScriptedFs {
            staging_read_limit: Some(10),
            ..ScriptedFs::default()
        };
        let err = export_over(&fs, "unreadable_staging", &out).await.unwrap_err();
        assert!(
            err.contains("injected read failure") && err.ends_with("the previous file was left as it was"),
            "unexpected error: {err}"
        );
        assert_eq!(std::fs::read(&out).unwrap(), PREVIOUS);
        assert!(staging_leftovers("unreadable_staging.csv").is_empty());
    }

    #[tokio::test]
    async fn an_existing_file_that_cannot_be_backed_up_is_not_touched() {
        let out = temp_path("unbackable.csv");
        std::fs::write(&out, PREVIOUS).unwrap();

        let fs = ScriptedFs {
            unreadable: Some(out.clone()),
            ..ScriptedFs::default()
        };
        let err = export_over(&fs, "unbackable", &out).await.unwrap_err();
        assert!(
            err.contains("could not be backed up first")
                && err.contains("injected unreadable")
                && err.ends_with("it was left as it was"),
            "unexpected error: {err}"
        );
        assert_eq!(std::fs::read(&out).unwrap(), PREVIOUS);
        assert!(staging_leftovers("unbackable.csv").is_empty());
    }

    #[tokio::test]
    async fn a_destination_that_cannot_be_created_is_left_as_it_was_and_nothing_is_kept() {
        // A folder the app may not write into: the rename is refused and so is
        // the copy's `File::create`, before a byte of the destination is
        // touched — so there is nothing to put back and nothing to keep.
        let out = temp_path("uncreatable.csv");
        std::fs::write(&out, PREVIOUS).unwrap();

        let fs = ScriptedFs {
            refuse_create: Some(out.clone()),
            ..ScriptedFs::default()
        };
        let err = export_over(&fs, "uncreatable", &out).await.unwrap_err();
        assert!(
            err.contains("injected refused create") && err.ends_with("the file was left as it was"),
            "unexpected error: {err}"
        );
        assert!(!err.contains("could not be put back"), "nothing was damaged: {err}");
        assert_eq!(std::fs::read(&out).unwrap(), PREVIOUS);
        assert!(staging_leftovers("uncreatable.csv").is_empty());
    }

    #[tokio::test]
    async fn a_new_destination_that_cannot_be_created_leaves_nothing_behind() {
        let out = temp_path("uncreatable_new.csv");
        let _ = std::fs::remove_file(&out);

        let fs = ScriptedFs {
            refuse_create: Some(out.clone()),
            ..ScriptedFs::default()
        };
        let err = export_over(&fs, "uncreatable_new", &out).await.unwrap_err();
        assert!(
            err.contains("injected refused create") && err.ends_with("the file was left as it was"),
            "unexpected error: {err}"
        );
        assert!(!out.exists(), "nothing may be created where the create was refused");
        assert!(staging_leftovers("uncreatable_new.csv").is_empty());
    }

    #[tokio::test]
    async fn when_the_previous_file_cannot_be_put_back_both_copies_are_kept() {
        let out = temp_path("damaged.csv");
        std::fs::write(&out, PREVIOUS).unwrap();

        // The copy fails after 10 bytes, and so does the restore after 5.
        let fs = ScriptedFs::default().write_limits(&out, &[10, 5]);
        let err = export_over(&fs, "damaged", &out).await.unwrap_err();
        assert!(err.contains("could not be put back"), "unexpected error: {err}");

        let leftovers = staging_leftovers("damaged.csv");
        let backup = leftovers.iter().find(|p| p.extension().unwrap() == "backup").unwrap();
        let staging = leftovers.iter().find(|p| p.extension().unwrap() == "partial").unwrap();
        assert!(err.contains(backup.to_str().unwrap()) && err.contains(staging.to_str().unwrap()));
        assert_eq!(std::fs::read(backup).unwrap(), PREVIOUS, "the previous contents survive");
        assert_eq!(std::fs::read(staging).unwrap(), expected_csv("damaged").await, "and so does the export");
        for p in leftovers {
            std::fs::remove_file(p).unwrap();
        }
    }
}
