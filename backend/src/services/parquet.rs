use arrow::record_batch::RecordBatch;
use parquet::arrow::arrow_reader::{ParquetRecordBatchReader, ParquetRecordBatchReaderBuilder};
use parquet::file::reader::{FileReader, SerializedFileReader};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Mutex as AsyncMutex;

use crate::models::{ColumnInfo, ColumnKind, ParquetMetadata, SortDirection, SortSpec};
use crate::services::access::FileAccess;

/// Cache for DataFusion SessionContext and Parquet metadata.
/// Stored as Tauri managed state to avoid re-creating sessions on every request.
///
/// The cache also scopes file access under the App Sandbox: an entry is
/// filled only after `FileAccess::acquire` has resolved the file's bookmark
/// (when it has one), and `evict` releases that grant. So a file stays
/// readable exactly as long as some tab shows it — DataFusion reopens the
/// file on every query, so the grant cannot end with the first read.
/// A fill that fails gives the grant back itself (`release_unless_used`):
/// the file gets no tab, so nothing would ever evict it, and each failed
/// open of a different file would otherwise hold one more grant until the
/// process ends.
/// How much memory a file's DataFusion session may hold at once, over every
/// query on it: the sorted grid's top-k heap, the SQL view's aggregates
/// and sorts. Operators that can spill (aggregates, a full sort) go to the
/// disk manager's temp directory past it; a top-k cannot and fails with
/// "Resources exhausted", which `sorted_page` turns into a message that
/// names the way out. Measured on a 58M-row, 7-column file in release:
/// the sorted page at offset 1M peaked at 2.1 GB of process memory, at
/// 5M at 3.3 GB, at the middle (29M) at 12.9 GB — the heap holds
/// `offset + limit` rows of the whole row. The limit keeps a deep page of
/// a huge file from taking the app down on a small machine; the pages
/// within reach of it are the far majority a viewer pages to.
pub const SESSION_MEMORY_LIMIT: usize = 2 * 1024 * 1024 * 1024;

// Shared across files, not an additional allowance for every open tab.
const RESULT_CACHE_BYTES: usize = 32 * 1024 * 1024;
const RESULT_CACHE_ENTRIES: usize = 64;

struct CachedResult {
    path: String,
    session_id: String,
    query: String,
    batches: Vec<RecordBatch>,
    bytes: usize,
}

pub struct ParquetCache {
    sessions: Mutex<HashMap<String, datafusion::execution::context::SessionContext>>,
    metadata: Mutex<HashMap<String, ParquetMetadata>>,
    results: Mutex<VecDeque<CachedResult>>,
    /// Per-path gates make a cache fill and eviction one atomic transition
    /// without serializing operations for unrelated files.
    session_gates: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    metadata_gates: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    access: Arc<FileAccess>,
    /// `SESSION_MEMORY_LIMIT`, unless a test lowers it.
    memory_limit: usize,
}

impl Default for ParquetCache {
    fn default() -> Self {
        Self::new()
    }
}

impl ParquetCache {
    /// A cache with no bookmarks and nothing persisted (the bridge, tests).
    pub fn new() -> Self {
        Self::with_access(Arc::new(FileAccess::disabled()))
    }

    pub fn with_access(access: Arc<FileAccess>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            metadata: Mutex::new(HashMap::new()),
            results: Mutex::new(VecDeque::new()),
            session_gates: Mutex::new(HashMap::new()),
            metadata_gates: Mutex::new(HashMap::new()),
            access,
            memory_limit: SESSION_MEMORY_LIMIT,
        }
    }

    /// The cache with a session memory limit of `bytes` (the tests set it
    /// far below what a sorted page needs).
    #[cfg(test)]
    pub fn with_memory_limit(mut self, bytes: usize) -> Self {
        self.memory_limit = bytes;
        self
    }

    fn gate_for(
        gates: &Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
        path: &str,
    ) -> Result<Arc<AsyncMutex<()>>, String> {
        let mut gates = gates.lock().map_err(|e| e.to_string())?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(path).and_then(Weak::upgrade) {
            return Ok(gate);
        }
        let gate = Arc::new(AsyncMutex::new(()));
        gates.insert(path.to_string(), Arc::downgrade(&gate));
        Ok(gate)
    }

    fn session_gate(&self, path: &str) -> Result<Arc<AsyncMutex<()>>, String> {
        Self::gate_for(&self.session_gates, path)
    }

    fn metadata_gate(&self, path: &str) -> Result<Arc<AsyncMutex<()>>, String> {
        Self::gate_for(&self.metadata_gates, path)
    }

    /// Get or create a SessionContext for the given file path.
    /// Returns a cloned SessionContext (SessionContext uses Arc internally, so cloning is cheap).
    ///
    /// # Single-partition execution — a deliberate trade-off
    ///
    /// Sessions are created with `target_partitions = 1`, so **everything that
    /// runs through this context — filtered paged reads, filtered exports, and
    /// the SQL view — executes single-threaded.** (Unfiltered pages and
    /// exports bypass the session: see `range_reader`.)
    ///
    /// Why: the filtered grid and the filtered export page with `LIMIT`/`OFFSET`
    /// and no `ORDER BY` (the file has no sort key to order by). With parallel
    /// partitions DataFusion merges results in arrival order, so the same
    /// offset could return different rows on different executions — pages
    /// could tear, and an exported "current page" could differ from the page
    /// on screen. One partition keeps every scan in file order and makes
    /// paging deterministic.
    ///
    /// Cost: the SQL view gives up multi-core execution, so heavy aggregations
    /// over large files run slower than DataFusion's default. A fair trade for
    /// a viewer whose queries are dominated by scan-and-page; if it ever
    /// hurts, split the cache into a paging session (1 partition) and a query
    /// session (default parallelism) rather than reverting this, or the
    /// paging guarantees above silently break.
    pub async fn get_or_create_session(
        &self,
        path: &str,
    ) -> Result<datafusion::execution::context::SessionContext, String> {
        // Check cache first. A hit may proceed while an already-started query
        // still uses that context; eviction only guarantees later creations
        // cannot repopulate the cache with an older context.
        {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(ctx) = sessions.get(path) {
                return Ok(ctx.clone());
            }
        }

        let gate = self.session_gate(path)?;
        let _gate = gate.lock().await;

        // A concurrent miss may have completed while this call waited.
        {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(ctx) = sessions.get(path) {
                return Ok(ctx.clone());
            }
        }

        // Create the session and register the parquet file. Single partition,
        // deliberately — see the trade-off note in this function's doc.
        self.access.acquire(path)?;
        let config = datafusion::execution::context::SessionConfig::new()
            .with_target_partitions(1)
            // Lets the SQL view answer SHOW TABLES / SHOW COLUMNS FROM t.
            .with_information_schema(true);
        // Bounded, see `SESSION_MEMORY_LIMIT`; the rest of the runtime is
        // the default, disk spilling included.
        let runtime = match datafusion::execution::runtime_env::RuntimeEnvBuilder::new()
            .with_memory_limit(self.memory_limit, 1.0)
            .build_arc()
        {
            Ok(runtime) => runtime,
            Err(e) => {
                self.release_unless_used(path, &self.metadata_gates);
                return Err(format!("Failed to set up the query runtime: {}", e));
            }
        };
        let ctx =
            datafusion::execution::context::SessionContext::new_with_config_rt(config, runtime);
        if let Err(e) = register_file_as_t(&ctx, path).await {
            self.release_unless_used(path, &self.metadata_gates);
            return Err(e);
        }

        // Store in cache
        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(path.to_string(), ctx.clone());
        }

        Ok(ctx)
    }

    /// Get cached metadata, or compute and cache it.
    pub async fn get_or_create_metadata(&self, path: &str) -> Result<ParquetMetadata, String> {
        self.get_or_create_metadata_with(path, || compute_metadata(path))
            .await
    }

    async fn get_or_create_metadata_with<F>(
        &self,
        path: &str,
        compute: F,
    ) -> Result<ParquetMetadata, String>
    where
        F: FnOnce() -> Result<ParquetMetadata, String>,
    {
        // Check cache first
        {
            let metadata_cache = self.metadata.lock().map_err(|e| e.to_string())?;
            if let Some(meta) = metadata_cache.get(path) {
                return Ok(meta.clone());
            }
        }

        let gate = self.metadata_gate(path)?;
        let _gate = gate.lock().await;

        // A concurrent miss may have completed while this call waited.
        {
            let metadata_cache = self.metadata.lock().map_err(|e| e.to_string())?;
            if let Some(meta) = metadata_cache.get(path) {
                return Ok(meta.clone());
            }
        }

        self.access.acquire(path)?;
        let meta = match compute() {
            Ok(meta) => meta,
            Err(e) => {
                self.release_unless_used(path, &self.session_gates);
                return Err(e);
            }
        };

        // Store in cache
        {
            let mut metadata_cache = self.metadata.lock().map_err(|e| e.to_string())?;
            metadata_cache.insert(path.to_string(), meta.clone());
        }

        Ok(meta)
    }

    /// Give back the grant a fill took when its compute / register failed,
    /// unless the other half still relies on it. Called by the failed fill
    /// while it holds its own gate; `other_gates` is the other half's.
    ///
    /// The grant is shared by the metadata and the session entry for a
    /// path (`FileAccess::acquire` is idempotent), so a plain release here
    /// would pull it from under a live entry or a fill in flight. Holding
    /// this fill's gate and a `try_lock` of the other one makes the check
    /// and the release one step: no fill of either kind can start in
    /// between, and one that is waiting on its gate resolves the bookmark
    /// again once it gets there. When the other gate is busy, its holder
    /// owns the grant now — a fill that keeps it in its entry or gives it
    /// back on its own failure, or an eviction that releases it anyway —
    /// and `try_lock` rather than a wait is what keeps this from
    /// deadlocking against `evict`, which takes the two gates in order.
    fn release_unless_used(
        &self,
        path: &str,
        other_gates: &Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    ) {
        let Ok(other_gate) = Self::gate_for(other_gates, path) else {
            return;
        };
        let Ok(_other_gate) = other_gate.try_lock() else {
            return;
        };
        let used = self
            .sessions
            .lock()
            .map(|sessions| sessions.contains_key(path))
            .unwrap_or(true)
            || self
                .metadata
                .lock()
                .map(|metadata| metadata.contains_key(path))
                .unwrap_or(true);
        if !used {
            self.access.release(path);
        }
    }

    /// Remove cached entries for a given file path.
    pub async fn evict(&self, path: &str) -> Result<(), String> {
        let session_gate = self.session_gate(path)?;
        let _session_gate = session_gate.lock().await;
        let metadata_gate = self.metadata_gate(path)?;
        let _metadata_gate = metadata_gate.lock().await;

        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(path);
            self.results.lock().map_err(|e| e.to_string())?.retain(|r| r.path != path);
        }
        if let Ok(mut metadata_cache) = self.metadata.lock() {
            metadata_cache.remove(path);
        }
        self.access.release(path);
        Ok(())
    }
}

/// Register the single file at `path` as table `t`.
///
/// `SessionContext::register_parquet` treats its argument as a listing-table
/// path: glob characters (`[`, `?`, `*`) in the file name are parsed as a
/// pattern and the directory is walked instead, and only files ending in the
/// lowercase `.parquet` extension are listed — so `report[1].parquet` failed
/// to read and `DATA.PARQUET` registered as an empty table while the metadata
/// (read through the parquet crate, which looks at neither) said otherwise.
/// Handing DataFusion a `file://` URL skips the glob parsing, and passing the
/// file's own extension keeps the listing from filtering it out.
///
/// Statistics collection stays off: with it on, DataFusion's selectivity
/// estimate does interval arithmetic on the row-group min/max, and a 64-bit
/// column holding a value at its type's limit (a u64 hash, an i64 sentinel)
/// overflows it — every `=` filter on such a file then fails with
/// "Selectivity is out of limit", and panics in debug builds. Reproduced on
/// DataFusion 40 and 54 alike. The browse grid gains nothing from the
/// statistics anyway.
async fn register_file_as_t(
    ctx: &datafusion::execution::context::SessionContext,
    path: &str,
) -> Result<(), String> {
    use datafusion::datasource::file_format::parquet::ParquetFormat;
    use datafusion::datasource::listing::ListingOptions;

    let file_path = std::path::Path::new(path);
    let url = url::Url::from_file_path(file_path).map_err(|_| {
        format!(
            "Failed to register parquet file: not an absolute path: {}",
            path
        )
    })?;
    let extension = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    let options = ListingOptions::new(Arc::new(ParquetFormat::default()))
        .with_file_extension(extension)
        .with_collect_stat(false);

    ctx.register_listing_table("t", url.as_str(), options, None, None)
        .await
        .map_err(|e| format!("Failed to register parquet file: {}", e))
}

fn logical_type_to_string(logical_type: &parquet::basic::LogicalType) -> String {
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
                if *is_signed { "" } else { "_UNSIGNED" }
            )
        }
        parquet::basic::LogicalType::Unknown => "UNKNOWN".to_string(),
        parquet::basic::LogicalType::Json => "JSON".to_string(),
        parquet::basic::LogicalType::Bson => "BSON".to_string(),
        parquet::basic::LogicalType::Uuid => "UUID".to_string(),
        parquet::basic::LogicalType::Float16 => "FLOAT16".to_string(),
        parquet::basic::LogicalType::Variant { .. } => "VARIANT".to_string(),
        parquet::basic::LogicalType::Geometry { .. } => "GEOMETRY".to_string(),
        parquet::basic::LogicalType::Geography { .. } => "GEOGRAPHY".to_string(),
        // The enum is non-exhaustive; show whatever a newer parquet adds.
        other => format!("{:?}", other).to_uppercase(),
    }
}

fn converted_type_to_string(converted_type: parquet::basic::ConvertedType) -> String {
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
        parquet::basic::ConvertedType::NONE => "NONE".to_string(),
    }
}

/// Label a group field (LIST / MAP / STRUCT) by the structure it represents.
/// Group fields carry no physical type at all, and asking one for its physical
/// type panics inside the parquet crate.
fn group_type_to_string(field: &parquet::schema::types::Type) -> String {
    use parquet::basic::{ConvertedType, LogicalType};

    match field.get_basic_info().logical_type_ref() {
        Some(LogicalType::List) => "LIST".to_string(),
        Some(LogicalType::Map) => "MAP".to_string(),
        _ => match field.get_basic_info().converted_type() {
            ConvertedType::LIST => "LIST".to_string(),
            ConvertedType::MAP | ConvertedType::MAP_KEY_VALUE => "MAP".to_string(),
            _ => "STRUCT".to_string(),
        },
    }
}

/// Classify a schema field structurally, following the same precedence the
/// display label uses: logical type, then converted type, then physical type.
fn column_kind(field: &parquet::schema::types::Type) -> ColumnKind {
    use parquet::basic::{ConvertedType, LogicalType, Type as PhysicalType};

    if !field.is_primitive() {
        return ColumnKind::Nested;
    }

    if let Some(logical_type) = field.get_basic_info().logical_type_ref() {
        return match logical_type {
            LogicalType::String | LogicalType::Enum | LogicalType::Json => ColumnKind::Text,
            LogicalType::Decimal { .. } => ColumnKind::Decimal,
            LogicalType::Date | LogicalType::Time { .. } | LogicalType::Timestamp { .. } => {
                ColumnKind::Temporal
            }
            LogicalType::Integer { .. } => ColumnKind::Integer,
            LogicalType::Float16 => ColumnKind::Float,
            LogicalType::Uuid | LogicalType::Bson => ColumnKind::Binary,
            LogicalType::Map | LogicalType::List => ColumnKind::Nested,
            // Variant is semi-structured, geospatial types are encoded bytes.
            LogicalType::Variant { .. } => ColumnKind::Nested,
            LogicalType::Geometry { .. } | LogicalType::Geography { .. } => ColumnKind::Binary,
            _ => ColumnKind::Other,
        };
    }

    match field.get_basic_info().converted_type() {
        ConvertedType::UTF8 | ConvertedType::ENUM | ConvertedType::JSON => ColumnKind::Text,
        ConvertedType::DECIMAL => ColumnKind::Decimal,
        ConvertedType::DATE
        | ConvertedType::TIME_MILLIS
        | ConvertedType::TIME_MICROS
        | ConvertedType::TIMESTAMP_MILLIS
        | ConvertedType::TIMESTAMP_MICROS => ColumnKind::Temporal,
        ConvertedType::UINT_8
        | ConvertedType::UINT_16
        | ConvertedType::UINT_32
        | ConvertedType::UINT_64
        | ConvertedType::INT_8
        | ConvertedType::INT_16
        | ConvertedType::INT_32
        | ConvertedType::INT_64 => ColumnKind::Integer,
        ConvertedType::BSON => ColumnKind::Binary,
        ConvertedType::MAP | ConvertedType::LIST | ConvertedType::MAP_KEY_VALUE => {
            ColumnKind::Nested
        }
        ConvertedType::INTERVAL => ColumnKind::Other,
        ConvertedType::NONE => match field.get_physical_type() {
            PhysicalType::BOOLEAN => ColumnKind::Boolean,
            PhysicalType::INT32 | PhysicalType::INT64 => ColumnKind::Integer,
            // Legacy nanosecond timestamps; read back as Timestamp.
            PhysicalType::INT96 => ColumnKind::Temporal,
            PhysicalType::FLOAT | PhysicalType::DOUBLE => ColumnKind::Float,
            PhysicalType::BYTE_ARRAY | PhysicalType::FIXED_LEN_BYTE_ARRAY => ColumnKind::Binary,
        },
    }
}

/// Open a parquet file for reading. Shared by metadata inspection and export.
pub fn open_file_reader(path: &str) -> Result<SerializedFileReader<File>, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {}", path, e))?;
    SerializedFileReader::new(file).map_err(|e| e.to_string())
}

/// A batch reader over `[offset, offset + limit)` of the file's rows, in file
/// order. The range is pushed into the parquet reader, which skips whole row
/// groups by their row counts instead of decoding everything before `offset`
/// — the difference between 160 ms and 2.5 s for the last page of a 58M-row
/// file. The range is clamped to the file, so a page past the end is empty
/// rather than an error. Shared by unfiltered page reads and exports; the
/// filtered variants go through DataFusion (`build_page_query`) instead.
pub fn range_reader(
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    batch_size: usize,
) -> Result<ParquetRecordBatchReader, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {}", path, e))?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)
        .map_err(|e| format!("Failed to open parquet file {}: {}", path, e))?;

    let num_rows = builder.metadata().file_metadata().num_rows();
    let total_rows = usize::try_from(num_rows).map_err(|_| {
        format!(
            "Failed to read parquet file {}: invalid row count {}",
            path, num_rows
        )
    })?;
    let offset = offset.unwrap_or(0).min(total_rows);
    let limit = limit
        .unwrap_or(total_rows - offset)
        .min(total_rows - offset);

    builder
        .with_batch_size(batch_size.max(1))
        .with_offset(offset)
        .with_limit(limit)
        .build()
        .map_err(|e| format!("Failed to read parquet file {}: {}", path, e))
}

fn compute_metadata(path: &str) -> Result<ParquetMetadata, String> {
    let reader = open_file_reader(path)?;
    let file_metadata = reader.metadata().file_metadata();
    let mut metadata = metadata_from_schema(file_metadata.schema(), file_metadata.num_rows())?;
    // Arrow's embedded schema can restore Date64 or Time32(Second) from
    // otherwise unannotated integers. Filters must use the type actually
    // decoded by Arrow/DataFusion, not treat its displayed date as a number.
    let arrow_schema = parquet::arrow::parquet_to_arrow_schema(
        file_metadata.schema_descr(),
        file_metadata.key_value_metadata(),
    )
    .map_err(|e| e.to_string())?;
    for (column, field) in metadata.columns.iter_mut().zip(arrow_schema.fields()) {
        if matches!(
            field.data_type(),
            DataType::Date32
                | DataType::Date64
                | DataType::Time32(_)
                | DataType::Time64(_)
                | DataType::Timestamp(_, _)
        ) && column.kind != ColumnKind::Temporal
        {
            column.kind = ColumnKind::Temporal;
            column.column_type = format!("{:?}", field.data_type());
        }
    }
    Ok(metadata)
}

/// Describe one top-level schema field the way the column header shows it.
fn column_info(field: &parquet::schema::types::Type) -> ColumnInfo {
    let physical_type = if field.is_primitive() {
        format!("{:?}", field.get_physical_type())
    } else {
        group_type_to_string(field)
    };
    let basic_info = field.get_basic_info();
    let logical_type = match (basic_info.logical_type_ref(), basic_info.converted_type()) {
        (Some(lt), _) => Some(logical_type_to_string(lt)),
        (None, parquet::basic::ConvertedType::NONE) => None,
        (None, converted) => Some(converted_type_to_string(converted)),
    };

    ColumnInfo {
        name: field.name().to_string(),
        column_type: logical_type
            .clone()
            .unwrap_or_else(|| physical_type.clone()),
        kind: column_kind(field),
        logical_type,
        physical_type,
    }
}

/// The metadata the webview shows for a file with this root schema and row
/// count. Pure: `compute_metadata` reads them from the file.
fn metadata_from_schema(
    schema: &parquet::schema::types::Type,
    num_rows: i64,
) -> Result<ParquetMetadata, String> {
    let columns: Vec<ColumnInfo> = schema.get_fields().iter().map(|f| column_info(f)).collect();

    // DataFusion cannot register a schema with duplicate field names, so every
    // read would fail after the tab had already opened. Refuse up front, with
    // the reason, instead of opening a tab that can only show an error.
    let mut seen = std::collections::HashSet::new();
    if let Some(duplicate) = columns.iter().find(|c| !seen.insert(c.name.as_str())) {
        return Err(format!(
            "This file has more than one column named \"{}\"; Parqsee cannot open files with duplicate column names.",
            duplicate.name
        ));
    }

    Ok(ParquetMetadata {
        num_rows,
        num_columns: columns.len(),
        columns,
    })
}

use arrow::array::{Array, ArrayRef, FixedSizeListArray, GenericListArray, MapArray, StructArray};
use arrow::datatypes::{DataType, Field, FieldRef, Schema};
use arrow::json::LineDelimitedWriter;

/// True for types whose values JSON cannot carry faithfully: decimals (the
/// arrow JSON writers refuse them outright) and floats (NaN and the infinities
/// have no JSON spelling, so the writer silently emits `null` for them).
fn contains_json_unsafe(data_type: &DataType) -> bool {
    match data_type {
        DataType::Decimal32(_, _)
        | DataType::Decimal64(_, _)
        | DataType::Decimal128(_, _)
        | DataType::Decimal256(_, _)
        | DataType::Float16
        | DataType::Float32
        | DataType::Float64
        // Written as a date-time ("2024-02-29T00:00:00") although it is a date.
        | DataType::Date64 => true,
        DataType::List(field)
        | DataType::LargeList(field)
        | DataType::FixedSizeList(field, _)
        | DataType::Map(field, _) => contains_json_unsafe(field.data_type()),
        DataType::Struct(fields) => fields.iter().any(|f| contains_json_unsafe(f.data_type())),
        _ => false,
    }
}

/// Floats stay numbers unless the column actually holds a value JSON cannot
/// represent; then the whole column is rendered as strings, with the
/// JavaScript spellings so NaN and ±Infinity stay distinguishable from NULL.
/// Used for exports and for floats nested inside containers; top-level
/// columns bound for the webview are handled per value instead, see
/// `restore_non_finite_floats`.
fn non_finite_floats_as_strings(array: &ArrayRef) -> Result<ArrayRef, String> {
    use arrow::array::{AsArray, StringArray};
    use arrow::datatypes::{Float16Type, Float32Type, Float64Type};

    let has_non_finite = match array.data_type() {
        DataType::Float16 => array
            .as_primitive::<Float16Type>()
            .iter()
            .flatten()
            .any(|v| !v.to_f32().is_finite()),
        DataType::Float32 => array
            .as_primitive::<Float32Type>()
            .iter()
            .flatten()
            .any(|v| !v.is_finite()),
        DataType::Float64 => array
            .as_primitive::<Float64Type>()
            .iter()
            .flatten()
            .any(|v| !v.is_finite()),
        _ => false,
    };
    if !has_non_finite {
        return Ok(array.clone());
    }
    let rendered = arrow::compute::cast(array, &DataType::Utf8)
        .map_err(|e| format!("Failed to render float column: {}", e))?;
    let rendered: StringArray = rendered
        .as_string::<i32>()
        .iter()
        .map(|v| {
            v.map(|text| match text {
                "NaN" | "nan" => "NaN",
                "inf" | "Infinity" => "Infinity",
                "-inf" | "-Infinity" => "-Infinity",
                // Arrow prints `1.0` where the webview would print `1`;
                // keep the rendered column looking like its neighbours.
                other => other.strip_suffix(".0").unwrap_or(other),
            })
        })
        .collect();
    Ok(Arc::new(rendered) as ArrayRef)
}

/// The field, re-typed for its converted values. Cloning the original keeps
/// its name, nullability and metadata.
fn retyped_field(field: &Field, data_type: &DataType) -> Arc<Field> {
    Arc::new(field.clone().with_data_type(data_type.clone()))
}

/// One body for List and LargeList: they differ only in the offset width, and
/// a fix applied to one hand-copied arm but not the other is exactly how
/// FixedSizeList was missed the first time round.
fn decimals_in_list<O: arrow::array::OffsetSizeTrait>(
    array: &ArrayRef,
    field: &Field,
) -> Result<ArrayRef, String> {
    let list = array
        .as_any()
        .downcast_ref::<GenericListArray<O>>()
        .ok_or_else(|| "Failed to read list column".to_string())?;
    let values = json_unsafe_as_strings(list.values())?;
    GenericListArray::<O>::try_new(
        retyped_field(field, values.data_type()),
        list.offsets().clone(),
        values,
        list.nulls().cloned(),
    )
    .map(|a| Arc::new(a) as ArrayRef)
    .map_err(|e| e.to_string())
}

fn decimals_in_struct(array: &StructArray) -> Result<StructArray, String> {
    let DataType::Struct(fields) = array.data_type() else {
        return Err("Failed to read struct column".to_string());
    };
    let converted = fields
        .iter()
        .zip(array.columns())
        .map(|(field, column)| {
            let column = json_unsafe_as_strings(column)?;
            Ok((retyped_field(field, column.data_type()), column))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let (converted_fields, converted_columns): (Vec<_>, Vec<_>) = converted.into_iter().unzip();
    StructArray::try_new(
        converted_fields.into(),
        converted_columns,
        array.nulls().cloned(),
    )
    .map_err(|e| e.to_string())
}

fn json_unsafe_as_strings(array: &ArrayRef) -> Result<ArrayRef, String> {
    if !contains_json_unsafe(array.data_type()) {
        return Ok(array.clone());
    }
    match array.data_type() {
        DataType::Decimal32(_, _)
        | DataType::Decimal64(_, _)
        | DataType::Decimal128(_, _)
        | DataType::Decimal256(_, _) => arrow::compute::cast(array, &DataType::Utf8)
            .map_err(|e| format!("Failed to render decimal column: {}", e)),
        DataType::Float16 | DataType::Float32 | DataType::Float64 => {
            non_finite_floats_as_strings(array)
        }
        DataType::Date64 => arrow::compute::cast(array, &DataType::Date32)
            .map_err(|e| format!("Failed to render date column: {}", e)),
        DataType::List(field) => decimals_in_list::<i32>(array, field),
        DataType::LargeList(field) => decimals_in_list::<i64>(array, field),
        DataType::FixedSizeList(field, size) => {
            let list = array
                .as_any()
                .downcast_ref::<FixedSizeListArray>()
                .ok_or_else(|| "Failed to read list column".to_string())?;
            let values = json_unsafe_as_strings(list.values())?;
            FixedSizeListArray::try_new(
                retyped_field(field, values.data_type()),
                *size,
                values,
                list.nulls().cloned(),
            )
            .map(|a| Arc::new(a) as ArrayRef)
            .map_err(|e| e.to_string())
        }
        DataType::Map(field, ordered) => {
            let map = array
                .as_any()
                .downcast_ref::<MapArray>()
                .ok_or_else(|| "Failed to read map column".to_string())?;
            let entries = decimals_in_struct(map.entries())?;
            MapArray::try_new(
                retyped_field(field, entries.data_type()),
                map.offsets().clone(),
                entries,
                map.nulls().cloned(),
                *ordered,
            )
            .map(|a| Arc::new(a) as ArrayRef)
            .map_err(|e| e.to_string())
        }
        DataType::Struct(_) => {
            let structs = array
                .as_any()
                .downcast_ref::<StructArray>()
                .ok_or_else(|| "Failed to read struct column".to_string())?;
            decimals_in_struct(structs).map(|a| Arc::new(a) as ArrayRef)
        }
        // contains_json_unsafe only claims the container types handled above.
        _ => Ok(array.clone()),
    }
}

/// Arrow's JSON writers refuse decimals outright, which used to fail the read
/// of any file carrying a money column, and they write NaN and ±Infinity as
/// `null`, which showed a pandas NaN as a missing value. Render both as
/// strings — exact, and distinguishable from NULL — print Date64 as the date
/// it is, and leave every other column alone.
pub fn json_unsafe_to_strings(batch: &RecordBatch) -> Result<RecordBatch, String> {
    convert_batch(batch, false)
}

/// `keep_top_level_floats` leaves top-level float columns untouched for
/// `batches_to_rows`, which restores NaN and ±Infinity per value afterwards
/// instead of rendering the whole column as strings; see
/// `restore_non_finite_floats`.
fn convert_batch(batch: &RecordBatch, keep_top_level_floats: bool) -> Result<RecordBatch, String> {
    rebuild_columns(batch, contains_json_unsafe, |field, column| {
        let column = if keep_top_level_floats && is_float(column.data_type()) {
            column.clone()
        } else {
            json_unsafe_as_strings(column)?
        };
        Ok((
            Arc::new(Field::new(
                field.name(),
                column.data_type().clone(),
                field.is_nullable(),
            )),
            column,
        ))
    })
}

/// Rebuild `batch` a column at a time, handing every field and column to
/// `convert`, and hand the batch straight back when no field answers
/// `needs_rebuild`.
///
/// That early return is the reason this is worth a function rather than a
/// loop at each call site: most files carry none of the types these
/// conversions exist for, and returning the batch is a refcount bump, where
/// rebuilding it allocates a schema and a column vector for every page read
/// and every exported batch.
fn rebuild_columns(
    batch: &RecordBatch,
    needs_rebuild: impl Fn(&DataType) -> bool,
    convert: impl Fn(&FieldRef, &ArrayRef) -> Result<(FieldRef, ArrayRef), String>,
) -> Result<RecordBatch, String> {
    let schema = batch.schema();
    if !schema.fields().iter().any(|f| needs_rebuild(f.data_type())) {
        return Ok(batch.clone());
    }

    let converted = schema
        .fields()
        .iter()
        .zip(batch.columns())
        .map(|(field, column)| convert(field, column))
        .collect::<Result<Vec<_>, String>>()?;
    let (fields, columns): (Vec<_>, Vec<_>) = converted.into_iter().unzip();

    RecordBatch::try_new(Arc::new(Schema::new(fields)), columns).map_err(|e| e.to_string())
}

fn is_nested(data_type: &DataType) -> bool {
    matches!(
        data_type,
        DataType::List(_)
            | DataType::LargeList(_)
            | DataType::FixedSizeList(_, _)
            | DataType::Map(_, _)
            | DataType::Struct(_)
    )
}

/// Render one nested column as one JSON document per row, matching what the
/// grid displays for it.
fn nested_column_as_json(name: &str, column: &ArrayRef) -> Result<ArrayRef, String> {
    let schema = Arc::new(Schema::new(vec![Field::new(
        name,
        column.data_type().clone(),
        true,
    )]));
    let batch = RecordBatch::try_new(schema, vec![column.clone()]).map_err(|e| e.to_string())?;
    let bytes = batches_to_json_bytes(&[batch])?;

    let values = serde_json::Deserializer::from_slice(&bytes)
        .into_iter::<serde_json::Map<String, Value>>()
        // A null value is written as an object without the field.
        .map(|row| row.map(|mut row| row.remove(name).map(|v| v.to_string())))
        .collect::<Result<Vec<Option<String>>, _>>()
        .map_err(|e| format!("Failed to render nested column: {}", e))?;

    Ok(Arc::new(arrow::array::StringArray::from(values)) as ArrayRef)
}

/// Arrow's CSV writer refuses nested columns ("Nested type List(...) is not
/// supported in CSV"). Serialize them as JSON text so a file with an array or
/// a struct column still exports.
pub fn nested_to_json_strings(batch: &RecordBatch) -> Result<RecordBatch, String> {
    rebuild_columns(batch, is_nested, |field, column| {
        if is_nested(field.data_type()) {
            Ok((
                Arc::new(Field::new(field.name(), DataType::Utf8, true)),
                nested_column_as_json(field.name(), column)?,
            ))
        } else {
            Ok((field.clone(), column.clone()))
        }
    })
}

fn batches_to_json_bytes(batches: &[RecordBatch]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    {
        let mut writer = LineDelimitedWriter::new(&mut buf);
        for batch in batches {
            writer
                .write(&convert_batch(batch, true)?)
                .map_err(|e| format!("Failed to write batch: {}", e))?;
        }
        writer
            .finish()
            .map_err(|e| format!("Failed to finish writing: {}", e))?;
    }
    Ok(buf)
}

/// True for column types whose values can exceed the JS safe-integer range.
fn contains_big_integer(data_type: &DataType) -> bool {
    match data_type {
        DataType::Int64 | DataType::UInt64 => true,
        DataType::List(field)
        | DataType::LargeList(field)
        | DataType::FixedSizeList(field, _)
        | DataType::Map(field, _) => contains_big_integer(field.data_type()),
        DataType::Struct(fields) => fields.iter().any(|f| contains_big_integer(f.data_type())),
        DataType::Dictionary(_, value) => contains_big_integer(value),
        _ => false,
    }
}

/// Decode record batches into one JSON value per row, in the exact shape the
/// webview receives: decimals and out-of-safe-range integers already rendered
/// as strings. Every read path the webview consumes MUST come through here —
/// the conversions live in this choke point precisely so a new path cannot
/// forget them.
pub fn batches_to_rows(batches: &[RecordBatch]) -> Result<Vec<Value>, String> {
    let buf = batches_to_json_bytes(batches)?;
    let mut rows = serde_json::Deserializer::from_slice(&buf)
        .into_iter::<Value>()
        .collect::<Result<Vec<Value>, _>>()
        .map_err(|e| format!("Failed to parse JSON results: {}", e))?;

    restore_non_finite_floats(&mut rows, batches);

    // The walk touches every value, so skip it for schemas that cannot hold
    // an unsafe integer (mirrors json_unsafe_to_strings' early return).
    let may_overflow = batches.first().is_some_and(|b| {
        b.schema()
            .fields()
            .iter()
            .any(|f| contains_big_integer(f.data_type()))
    });
    if may_overflow {
        rows.iter_mut().for_each(stringify_unsafe_integers);
    }

    Ok(rows)
}

/// The largest integer a JS number represents exactly.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn is_float(data_type: &DataType) -> bool {
    matches!(
        data_type,
        DataType::Float16 | DataType::Float32 | DataType::Float64
    )
}

/// The JavaScript spelling of a float JSON cannot carry, or None for a finite one.
fn non_finite_spelling(v: f64) -> Option<&'static str> {
    if v.is_nan() {
        Some("NaN")
    } else if v.is_infinite() {
        Some(if v > 0.0 { "Infinity" } else { "-Infinity" })
    } else {
        None
    }
}

/// Arrow's JSON writer drops NaN and ±Infinity as null. Put them back as
/// their JavaScript spellings, per value, so a finite float is always a JSON
/// number no matter which rows share its batch. Rendering the whole column
/// as strings whenever one value was non-finite (what the export path still
/// does, since it has no per-value stage) made the same value a number on
/// one page and a string on another, depending on where the batches fell.
/// Floats nested inside lists, structs and maps still take the column-wide
/// route in `non_finite_floats_as_strings`.
fn restore_non_finite_floats(rows: &mut [Value], batches: &[RecordBatch]) {
    use arrow::array::AsArray;
    use arrow::datatypes::{Float16Type, Float32Type, Float64Type};

    let mut offset = 0;
    for batch in batches {
        for (field, column) in batch.schema().fields().iter().zip(batch.columns()) {
            let spellings: Vec<(usize, &'static str)> = match column.data_type() {
                DataType::Float64 => column
                    .as_primitive::<Float64Type>()
                    .iter()
                    .enumerate()
                    .filter_map(|(i, v)| v.and_then(non_finite_spelling).map(|s| (i, s)))
                    .collect(),
                DataType::Float32 => column
                    .as_primitive::<Float32Type>()
                    .iter()
                    .enumerate()
                    .filter_map(|(i, v)| {
                        v.and_then(|v| non_finite_spelling(v as f64))
                            .map(|s| (i, s))
                    })
                    .collect(),
                DataType::Float16 => column
                    .as_primitive::<Float16Type>()
                    .iter()
                    .enumerate()
                    .filter_map(|(i, v)| {
                        v.and_then(|v| non_finite_spelling(v.to_f64()))
                            .map(|s| (i, s))
                    })
                    .collect(),
                _ => continue,
            };
            for (i, text) in spellings {
                if let Some(Value::Object(row)) = rows.get_mut(offset + i) {
                    row.insert(field.name().clone(), Value::String(text.to_string()));
                }
            }
        }
        offset += batch.num_rows();
    }
}

/// Every value crosses the IPC boundary as JSON, and the webview parses it
/// into doubles, so an i64 past 2^53 arrives silently rounded — an id column
/// would display a value the file does not contain. Hand those over as
/// strings instead; the grid prints values verbatim, and filters and queries
/// run in Rust against the real column type.
fn stringify_unsafe_integers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            let unsafe_integer = match (number.as_i64(), number.as_u64()) {
                (Some(v), _) => !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&v),
                (None, Some(v)) => v > MAX_SAFE_INTEGER as u64,
                _ => false,
            };
            if unsafe_integer {
                *value = Value::String(number.to_string());
            }
        }
        Value::Array(items) => items.iter_mut().for_each(stringify_unsafe_integers),
        Value::Object(fields) => fields.values_mut().for_each(stringify_unsafe_integers),
        _ => {}
    }
}

/// The filter the webview sent, or None when it is absent or blank. This is
/// the one place that decides what "no filter" means for the grid, the count
/// and the export alike.
pub fn where_clause(filter: Option<&str>) -> Option<&str> {
    filter.map(str::trim).filter(|f| !f.is_empty())
}

/// DataFusion lower-cases bare identifiers, so `MixedCase` resolves to
/// nothing; the filter bar quotes the same way.
pub fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Whether a column can be a sort key: everything but nested values (lists,
/// structs, maps, variants) and the types with no order (intervals). The
/// header offers the sort button by the same kind, so a sort the webview
/// sends always passes; the check is for a session restored from a file
/// that has changed shape since.
pub fn is_sortable(kind: ColumnKind) -> bool {
    !matches!(kind, ColumnKind::Nested | ColumnKind::Other)
}

/// The `ORDER BY` terms for `sort` over a file with `columns`: the sort
/// column first, then every other sortable column in file order, all in
/// the same direction.
///
/// The tie-breakers are what make paging over a sorted grid safe. Pages
/// are separate `ORDER BY ... LIMIT/OFFSET` queries, and DataFusion
/// answers each with a top-k heap sized to that page's `offset + limit`,
/// whose order among equal keys depends on the heap's shape — so two
/// pages of `ORDER BY category` alone could show the same row twice and
/// another never, whenever a run of equal values crossed the page boundary
/// (a category column with five values crosses it on every page). With
/// every sortable column in the key, rows that compare equal are identical
/// in every value the grid can show, so whichever of them lands where, the
/// pages read the same. Rows that differ only in a nested or unordered
/// column are the one case this leaves open; they sort as equal and may
/// swap places between two reads.
///
/// The direction applies to every term, so descending is exactly the
/// ascending sequence reversed, NULLs included (`ASC NULLS LAST`,
/// `DESC NULLS FIRST`, spelled out rather than left to the dialect).
pub fn order_by_terms(sort: &SortSpec, columns: &[ColumnInfo]) -> Result<String, String> {
    let key = columns
        .iter()
        .find(|c| c.name == sort.column)
        .ok_or_else(|| format!("Cannot sort by {}: no such column", sort.column))?;
    if !is_sortable(key.kind) {
        return Err(format!("Cannot sort by {}: values of its type have no order", sort.column));
    }
    let direction = match sort.direction {
        SortDirection::Asc => "ASC NULLS LAST",
        SortDirection::Desc => "DESC NULLS FIRST",
    };
    let terms = std::iter::once(key)
        .chain(columns.iter().filter(|c| c.name != sort.column && is_sortable(c.kind)))
        .map(|c| format!("{} {}", quote_identifier(&c.name), direction))
        .collect::<Vec<_>>();
    Ok(terms.join(", "))
}

/// The one `SELECT * FROM t ...` shape the browse grid and the filtered
/// export share. Building it in one place keeps the exported rows the same
/// rows the grid paginates over. `order_by` is the term list from
/// `order_by_terms`, or `None` for file order.
pub fn build_page_query(
    filter: Option<&str>,
    order_by: Option<&str>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> String {
    let mut query = String::from("SELECT * FROM t");
    if let Some(f) = where_clause(filter) {
        query.push_str(&format!(" WHERE {}", f));
    }
    if let Some(order_by) = order_by {
        query.push_str(&format!(" ORDER BY {}", order_by));
    }
    if let Some(limit) = limit {
        query.push_str(&format!(" LIMIT {}", limit));
    }
    if let Some(offset) = offset.filter(|o| *o > 0) {
        query.push_str(&format!(" OFFSET {}", offset));
    }
    query
}

/// One page of rows. Without a filter or a sort the page comes straight
/// from the parquet reader with the range pushed down (see `range_reader`);
/// a `LIMIT/OFFSET` query would decode every row before the page, so the
/// last page of a large file took seconds in release and a minute in
/// debug. With a filter or a sort the page is the DataFusion query the
/// export shares, so what is exported is what the grid shows. Both paths
/// read row groups in file order, so the two paginate the same sequence.
/// A sort is an `ORDER BY` over the whole file for every page, a scan per
/// page — the price of a sort key the file does not have; see
/// `order_by_terms` for what keeps its pages consistent and `sorted_page`
/// for how the deep pages are kept as cheap as the first.
pub async fn read_data(
    cache: &ParquetCache,
    path: &str,
    offset: usize,
    limit: usize,
    filter: Option<String>,
    sort: Option<SortSpec>,
) -> Result<Vec<Value>, String> {
    if let Some(sort) = sort {
        return batches_to_rows(&sorted_page_batches(cache, path, offset, limit, filter, sort).await?);
    }
    let batches = match where_clause(filter.as_deref()) {
        None => {
            // Decoding is CPU-bound; keep it off the async workers so other
            // commands (a count, another tab's page) are not stalled behind it.
            let path = path.to_string();
            tokio::task::spawn_blocking(move || {
                range_reader(&path, Some(offset), Some(limit), limit)?
                    .map(|b| b.map_err(|e| format!("Failed to read parquet file {}: {}", path, e)))
                    .collect::<Result<Vec<RecordBatch>, String>>()
            })
            .await
            .map_err(|e| format!("Page read task failed: {}", e))??
        }
        Some(_) => {
            let query = build_page_query(filter.as_deref(), None, Some(offset), Some(limit));
            execute_sql_with_cache(cache, path, &query).await?.0
        }
    };

    batches_to_rows(&batches)
}

pub async fn count_data(
    cache: &ParquetCache,
    path: &str,
    filter: Option<String>,
) -> Result<usize, String> {
    let query = match where_clause(filter.as_deref()) {
        Some(f) => format!("SELECT COUNT(*) FROM t WHERE {}", f),
        None => "SELECT COUNT(*) FROM t".to_string(),
    };

    let batches = execute_browse_query(cache, path, &query).await?;
    count_from_batches(&batches)
}

/// Only deterministic browse queries are reusable. Stable functions (now,
/// current_date, etc.) are stable within a query, not across page loads.
fn reusable_plan(plan: &datafusion::logical_expr::LogicalPlan) -> Result<bool, String> {
    use datafusion::common::tree_node::{TreeNode, TreeNodeRecursion};
    use datafusion::logical_expr::{Expr, Volatility};
    let mut reusable = true;
    plan.apply_with_subqueries(|node| {
        node.apply_expressions(|expr| {
            expr.apply(|expr| {
                if let Expr::ScalarFunction(function) = expr {
                    reusable &= function.func.signature().volatility == Volatility::Immutable;
                }
                Ok(TreeNodeRecursion::Continue)
            })
        })
    }).map_err(|e| e.to_string())?;
    Ok(reusable)
}

/// Bounded LRU of Arrow batches. Session identity prevents an in-flight read
/// from repopulating the cache after Refresh/close evicts that session.
async fn execute_browse_query(
    cache: &ParquetCache,
    path: &str,
    query: &str,
) -> Result<Vec<RecordBatch>, String> {
    let ctx = cache.get_or_create_session(path).await?;
    let session_id = ctx.session_id();
    {
        let mut results = cache.results.lock().map_err(|e| e.to_string())?;
        if let Some(index) = results.iter().position(|r| {
            r.path == path && r.session_id == session_id && r.query == query
        }) {
            let result = results.remove(index).expect("cache entry exists");
            let batches = result.batches.clone();
            results.push_back(result);
            return Ok(batches);
        }
    }
    let plan = plan_query_checked(&ctx, query).await?;
    let reusable = reusable_plan(&plan)?;
    let batches = ctx.execute_logical_plan(plan).await
        .map_err(|e| format!("SQL execution failed: {}", e))?
        .collect().await.map_err(|e| format!("Failed to collect results: {}", e))?;
    // Include keys as well as arrays; do not retain an unbounded filter string.
    let bytes = batches.iter().map(RecordBatch::get_array_memory_size).sum::<usize>()
        + path.len() + session_id.len() + query.len();
    if reusable && bytes <= RESULT_CACHE_BYTES {
        let sessions = cache.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.get(path).is_some_and(|ctx| ctx.session_id() == session_id) {
            let mut results = cache.results.lock().map_err(|e| e.to_string())?;
            results.retain(|r| !(r.path == path && r.session_id == session_id && r.query == query));
            let mut used = results.iter().map(|r| r.bytes).sum::<usize>();
            while results.len() >= RESULT_CACHE_ENTRIES || used + bytes > RESULT_CACHE_BYTES {
                if let Some(old) = results.pop_front() {
                    used -= old.bytes;
                }
            }
            results.push_back(CachedResult {
                path: path.into(), session_id, query: query.into(), batches: batches.clone(), bytes,
            });
        }
    }
    Ok(batches)
}

/// The window of the reversed sequence that holds page `[offset, offset +
/// limit)` of a sequence of `total` rows, when the page lies in the far
/// half; `None` for a page in the near half, which is read as it is.
///
/// DataFusion answers `ORDER BY ... LIMIT l OFFSET o` with a top-k heap of
/// `o + l` rows, so a page's cost grows with its offset: on a 58M-row file
/// the first page sorted in 2.5–3.8 s, the page at offset 1M in 29 s, and
/// the last page in 180 s with an 11 GB peak — the whole file in the heap.
/// The descending order is the exact reverse of the ascending one (every
/// key in the same direction, `NULLS LAST` / `NULLS FIRST` swapped), so
/// the last page ascending is the first page descending read backwards,
/// and a page past the midpoint is read from the other end with the same
/// small heap. The worst page is now the middle one, at half the file.
pub fn mirrored_window(offset: usize, limit: usize, total: usize) -> Option<(usize, usize)> {
    if offset >= total || offset <= total / 2 {
        return None;
    }
    let limit = limit.min(total - offset);
    Some((total - offset - limit, limit))
}

/// A page of the sorted sequence: the `ORDER BY ... LIMIT/OFFSET` query
/// as is for the near half, and for the far half the same window of the
/// reversed order, read from the other end and turned around
/// (`mirrored_window`). The filtered count that decides which half a page
/// is in is a scan of its own, cheap beside the sort.
pub(crate) async fn sorted_page_batches(
    cache: &ParquetCache,
    path: &str,
    offset: usize,
    limit: usize,
    filter: Option<String>,
    sort: SortSpec,
) -> Result<Vec<RecordBatch>, String> {
    let metadata = cache.get_or_create_metadata(path).await?;
    let total = match where_clause(filter.as_deref()) {
        Some(_) => count_data(cache, path, filter.clone()).await?,
        None => usize::try_from(metadata.num_rows).unwrap_or(usize::MAX),
    };
    let (sort, offset, limit, mirrored) = match mirrored_window(offset, limit, total) {
        Some((offset, limit)) => (
            SortSpec {
                column: sort.column,
                direction: sort.direction.reversed(),
            },
            offset,
            limit,
            true,
        ),
        None => (sort, offset, limit, false),
    };
    let order_by = order_by_terms(&sort, &metadata.columns)?;
    let query = build_page_query(filter.as_deref(), Some(&order_by), Some(offset), Some(limit));
    let batches = match execute_sql_with_cache(cache, path, &query).await {
        Ok((batches, _)) => batches,
        // The top-k heap for a page this deep outgrew `SESSION_MEMORY_LIMIT`.
        Err(e) if e.contains("Resources exhausted") => {
            return Err("This page is too deep into the sort for a file this large: sorting it \
                 needs more memory than the app allows itself. Narrow the rows with a \
                 filter, page from the other end, or sort in the SQL view."
                .to_string());
        }
        Err(e) => return Err(e),
    };
    if mirrored {
        // Reverse Arrow rows before any JSON conversion so exports retain
        // the original types and exact values. Reverse batch order as well.
        batches.iter().rev().map(|batch| {
            let indices = arrow::array::UInt64Array::from_iter_values((0..batch.num_rows() as u64).rev());
            let columns = batch.columns().iter()
                .map(|column| arrow::compute::take(column.as_ref(), &indices, None))
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            RecordBatch::try_new(batch.schema(), columns).map_err(|e| e.to_string())
        }).collect()
    } else {
        Ok(batches)
    }
}

/// The single value of a `SELECT COUNT(*)` result; an empty result counts as 0.
fn count_from_batches(batches: &[RecordBatch]) -> Result<usize, String> {
    let Some(batch) = batches.iter().find(|b| b.num_rows() > 0) else {
        return Ok(0);
    };
    let count = batch
        .column(0)
        .as_any()
        .downcast_ref::<arrow::array::Int64Array>()
        .ok_or_else(|| "Failed to downcast count result".to_string())?
        .value(0);
    usize::try_from(count).map_err(|_| format!("Invalid row count: {}", count))
}

pub async fn execute_sql_with_cache(
    cache: &ParquetCache,
    file_path: &str,
    query: &str,
) -> Result<(Vec<RecordBatch>, arrow::datatypes::SchemaRef), String> {
    let (batches, schema, _) = execute_sql_limited(cache, file_path, query, None).await?;
    Ok((batches, schema))
}

/// Run `query`, keeping at most `max_rows` rows of the result. The limit is
/// pushed into the plan, so a `SELECT *` over a large file does not
/// materialize every row before being cut down. The returned flag tells
/// whether rows were dropped.
pub async fn execute_sql_limited(
    cache: &ParquetCache,
    file_path: &str,
    query: &str,
    max_rows: Option<usize>,
) -> Result<(Vec<RecordBatch>, arrow::datatypes::SchemaRef, bool), String> {
    let ctx = cache.get_or_create_session(file_path).await?;

    let plan = plan_query_checked(&ctx, query).await?;
    let is_explain = matches!(
        plan,
        datafusion::logical_expr::LogicalPlan::Explain(_)
            | datafusion::logical_expr::LogicalPlan::Analyze(_)
    );

    let mut df = ctx
        .execute_logical_plan(plan)
        .await
        .map_err(|e| format!("SQL execution failed: {}", e))?;

    let schema = df.schema().inner().clone();

    // EXPLAIN must stay the root of its plan; a LIMIT on top of it is an
    // internal error, and its output is a handful of rows anyway.
    if let (Some(max), false) = (max_rows, is_explain) {
        // Fetch one extra row so we can tell a full page from a truncated one.
        df = df
            .limit(0, Some(max + 1))
            .map_err(|e| format!("Failed to limit results: {}", e))?;
    }

    let batches = df
        .collect()
        .await
        .map_err(|e| format!("Failed to collect results: {}", e))?;

    let (batches, truncated) = match max_rows {
        Some(max) => truncate_batches(batches, max),
        None => (batches, false),
    };

    Ok((batches, schema, truncated))
}

/// Plan a query against the shared session and refuse anything that is not a
/// read. Every path that hands user-written SQL to a session — the SQL view,
/// and the filter a paged read or an export carries — goes through here
/// rather than through `SessionContext::sql`, which runs DDL and SET
/// statements while it plans. The session is shared with the browse grid: a
/// `DROP TABLE t` took paging down with it, and a `SET target_partitions`
/// silently voided the single-partition ordering guarantee that keeps a
/// filtered page's row order deterministic. The viewer only ever reads, so
/// anything that would change the session or touch the filesystem is
/// rejected before it runs.
pub async fn plan_query_checked(
    ctx: &datafusion::execution::context::SessionContext,
    query: &str,
) -> Result<datafusion::logical_expr::LogicalPlan, String> {
    let plan = ctx
        .state()
        .create_logical_plan(query)
        .await
        .map_err(|e| format!("SQL execution failed: {}", e))?;
    reject_non_query(&plan)?;
    Ok(plan)
}

/// The SQL view is read-only. DDL (`CREATE`/`DROP TABLE`), `SET`, DML and
/// `COPY ... TO` would mutate the shared session or write files; name the
/// statement kind so the message explains what was refused.
fn reject_non_query(plan: &datafusion::logical_expr::LogicalPlan) -> Result<(), String> {
    use datafusion::logical_expr::LogicalPlan;
    let kind = match plan {
        LogicalPlan::Ddl(_) => "DDL statements (CREATE, DROP, ALTER)",
        LogicalPlan::Dml(_) => "INSERT, UPDATE and DELETE",
        LogicalPlan::Copy(_) => "COPY",
        LogicalPlan::Statement(_) => "SET and transaction statements",
        _ => return Ok(()),
    };
    Err(format!(
        "The SQL view is read-only: {} are not allowed. Use SELECT queries against table t.",
        kind
    ))
}

/// The first `max` rows of `batches`, and whether anything was dropped.
fn truncate_batches(batches: Vec<RecordBatch>, max: usize) -> (Vec<RecordBatch>, bool) {
    let total: usize = batches.iter().map(|b| b.num_rows()).sum();
    if total <= max {
        return (batches, false);
    }
    let kept = batches
        .into_iter()
        .scan(max, |remaining, batch| {
            if *remaining == 0 {
                return None;
            }
            let take = batch.num_rows().min(*remaining);
            *remaining -= take;
            Some(if take == batch.num_rows() {
                batch
            } else {
                batch.slice(0, take)
            })
        })
        .collect();
    (kept, true)
}

#[cfg(test)]
mod tests {
    use super::{truncate_batches, ParquetCache};
    use crate::models::{ColumnInfo, ColumnKind, ParquetMetadata, SortDirection, SortSpec};
    use crate::services::test_support::{self, write_parquet};
    use arrow::array::{
        Array, ArrayRef, Decimal128Array, Decimal128Builder, FixedSizeListBuilder, Int32Array,
        Int32Builder, Int64Array, ListBuilder, MapBuilder, StringArray, StringBuilder, StructArray,
    };
    use arrow::datatypes::{DataType, Field, Fields, Schema};
    use arrow::record_batch::RecordBatch;
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn temp_path(name: &str) -> PathBuf {
        test_support::temp_path("parquet", name)
    }

    /// A list column and a struct column next to a plain one, the shape Spark
    /// and pandas produce all the time.
    fn write_nested_fixture() -> PathBuf {
        let mut list = ListBuilder::new(Int32Builder::new());
        for row in 0..2 {
            list.values().append_value(row);
            list.values().append_value(row + 1);
            list.append(true);
        }
        let point_fields: Fields = vec![
            Field::new("x", DataType::Int32, true),
            Field::new("y", DataType::Int32, true),
        ]
        .into();
        let point = StructArray::new(
            point_fields.clone(),
            vec![
                Arc::new(Int32Array::from(vec![1, 2])) as ArrayRef,
                Arc::new(Int32Array::from(vec![3, 4])) as ArrayRef,
            ],
            None,
        );

        let schema = Arc::new(Schema::new(vec![
            Field::new("name", DataType::Utf8, true),
            Field::new(
                "tags",
                DataType::List(Arc::new(Field::new("item", DataType::Int32, true))),
                true,
            ),
            Field::new("point", DataType::Struct(point_fields), true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(vec!["a", "b"])) as ArrayRef,
                Arc::new(list.finish()),
                Arc::new(point),
            ],
        )
        .unwrap();

        let path = temp_path("nested.parquet");
        write_parquet(&path, &batch, None);
        path
    }

    /// A money column, plus a decimal nested inside a struct and a list.
    fn write_decimal_fixture() -> PathBuf {
        let amount = Decimal128Array::from(vec![123456789i128, -1i128])
            .with_precision_and_scale(20, 4)
            .unwrap();

        let mut prices = ListBuilder::new(
            Decimal128Builder::new()
                .with_precision_and_scale(10, 2)
                .unwrap(),
        );
        for _ in 0..2 {
            prices.values().append_value(150);
            prices.append(true);
        }
        let prices = prices.finish();

        let line_fields: Fields = vec![Field::new("net", DataType::Decimal128(20, 4), true)].into();
        let line = StructArray::new(
            line_fields.clone(),
            vec![Arc::new(
                Decimal128Array::from(vec![5000i128, 6000i128])
                    .with_precision_and_scale(20, 4)
                    .unwrap(),
            ) as ArrayRef],
            None,
        );

        let schema = Arc::new(Schema::new(vec![
            Field::new("amount", DataType::Decimal128(20, 4), true),
            Field::new("prices", prices.data_type().clone(), true),
            Field::new("line", DataType::Struct(line_fields), true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(amount) as ArrayRef,
                Arc::new(prices),
                Arc::new(line),
            ],
        )
        .unwrap();

        let path = temp_path("decimal.parquet");
        write_parquet(&path, &batch, None);
        path
    }

    #[tokio::test]
    async fn decimals_inside_maps_and_fixed_size_lists_convert_too() {
        // map<string, decimal> is what Spark produces for a decimal-valued map.
        let mut map = MapBuilder::new(
            None,
            StringBuilder::new(),
            Decimal128Builder::new()
                .with_precision_and_scale(10, 2)
                .unwrap(),
        );
        map.keys().append_value("price");
        map.values().append_value(150);
        map.append(true).unwrap();
        let map = map.finish();

        let mut pair = FixedSizeListBuilder::new(
            Decimal128Builder::new()
                .with_precision_and_scale(10, 2)
                .unwrap(),
            2,
        );
        pair.values().append_value(100);
        pair.values().append_value(200);
        pair.append(true);
        let pair = pair.finish();

        let schema = Arc::new(Schema::new(vec![
            Field::new("m", map.data_type().clone(), true),
            Field::new("pair", pair.data_type().clone(), true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(map) as ArrayRef, Arc::new(pair)],
        )
        .unwrap();
        let path = temp_path("decimal_containers.parquet");
        write_parquet(&path, &batch, None);

        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 1, None, None)
            .await
            .expect("decimals inside maps and fixed-size lists must not fail the read");

        assert_eq!(rows[0]["m"]["price"], "1.50");
        assert_eq!(rows[0]["pair"][0], "1.00");
        assert_eq!(rows[0]["pair"][1], "2.00");
    }

    /// The narrow decimals arrow added after 128/256 take the same string
    /// path, at the top level and inside a list, or the JSON writer would
    /// refuse the batch.
    #[tokio::test]
    async fn narrow_decimals_render_as_exact_strings() {
        use arrow::array::{Decimal32Array, Decimal32Builder, Decimal64Array};
        let small = Decimal32Array::from(vec![Some(12345), None])
            .with_precision_and_scale(9, 2)
            .unwrap();
        let medium = Decimal64Array::from(vec![Some(-1i64), Some(123456789012345678i64)])
            .with_precision_and_scale(18, 4)
            .unwrap();
        let mut prices = ListBuilder::new(
            Decimal32Builder::new()
                .with_precision_and_scale(9, 2)
                .unwrap(),
        );
        for _ in 0..2 {
            prices.values().append_value(150);
            prices.append(true);
        }
        let prices = prices.finish();

        let schema = Arc::new(Schema::new(vec![
            Field::new("small", DataType::Decimal32(9, 2), true),
            Field::new("medium", DataType::Decimal64(18, 4), true),
            Field::new("prices", prices.data_type().clone(), true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(small) as ArrayRef,
                Arc::new(medium),
                Arc::new(prices),
            ],
        )
        .unwrap();
        let path = temp_path("narrow_decimals.parquet");
        write_parquet(&path, &batch, None);

        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 2, None, None)
            .await
            .expect("narrow decimals must not fail the read");
        assert_eq!(rows[0]["small"], "123.45");
        assert!(rows[1].get("small").map_or(true, |v| v.is_null()));
        assert_eq!(rows[0]["medium"], "-0.0001");
        assert_eq!(rows[1]["medium"], "12345678901234.5678");
        assert_eq!(rows[0]["prices"][0], "1.50");
    }

    /// pandas writes missing floats as NaN; the grid must not show them as NULL.
    #[tokio::test]
    async fn non_finite_floats_are_distinguishable_from_null() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("x", DataType::Float64, true),
            Field::new("y", DataType::Float32, true),
            Field::new("plain", DataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(arrow::array::Float64Array::from(vec![
                    Some(f64::NAN),
                    Some(f64::INFINITY),
                    Some(f64::NEG_INFINITY),
                    Some(1.5),
                    None,
                    Some(2.0),
                ])) as ArrayRef,
                Arc::new(arrow::array::Float32Array::from(vec![
                    Some(2.0),
                    None,
                    None,
                    None,
                    None,
                    None,
                ])),
                Arc::new(arrow::array::Float64Array::from(vec![
                    Some(0.1 + 0.2),
                    None,
                    None,
                    None,
                    None,
                    None,
                ])),
            ],
        )
        .unwrap();
        let path = temp_path("nan.parquet");
        write_parquet(&path, &batch, None);

        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 6, None, None)
            .await
            .unwrap();
        assert_eq!(rows[0]["x"], "NaN");
        assert_eq!(rows[1]["x"], "Infinity");
        assert_eq!(rows[2]["x"], "-Infinity");
        // Finite values in the same column stay numbers — only the values
        // JSON cannot carry are spelled out.
        assert_eq!(rows[3]["x"], 1.5);
        assert_eq!(rows[5]["x"], 2.0);
        assert!(rows[4].get("x").is_none());
        // Columns without a non-finite value stay numbers.
        assert_eq!(rows[0]["y"], 2.0);
        assert_eq!(rows[0]["plain"], 0.1 + 0.2);
    }

    #[tokio::test]
    async fn decimal_columns_reach_the_webview_as_exact_strings() {
        let path = write_decimal_fixture();
        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 2, None, None)
            .await
            .expect("decimal columns must not fail the read");

        assert_eq!(rows[0]["amount"], "12345.6789");
        assert_eq!(rows[1]["amount"], "-0.0001");
        assert_eq!(rows[0]["prices"][0], "1.50");
        assert_eq!(rows[0]["line"]["net"], "0.5000");
    }

    fn write_small(path: &Path) {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false)]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int64Array::from(vec![1, 2, 3])) as ArrayRef],
        )
        .unwrap();
        write_parquet(path, &batch, None);
    }

    /// macOS is case-insensitive, so `DATA.PARQUET` is a perfectly ordinary
    /// file name there; the listing must not drop it for its extension.
    #[tokio::test]
    async fn reads_files_with_an_uppercase_extension() {
        let path = temp_path("UPPER.PARQUET");
        write_small(&path);
        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 10, None, None)
            .await
            .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            super::count_data(&cache, &path.to_string_lossy(), None)
                .await
                .unwrap(),
            3
        );
    }

    #[tokio::test]
    async fn counts_are_reused_and_refresh_invalidates_them() {
        let path = temp_path("cached_count.parquet");
        write_small(&path);
        let file = path.to_string_lossy();
        let cache = ParquetCache::new();
        let filter = Some("id > 1".into());
        assert_eq!(super::count_data(&cache, &file, filter.clone()).await.unwrap(), 2);
        // A hit must not open the source again.
        let moved = path.with_extension("saved");
        std::fs::rename(&path, &moved).unwrap();
        assert_eq!(super::count_data(&cache, &file, filter.clone()).await.unwrap(), 2);
        std::fs::rename(&moved, &path).unwrap();
        cache.evict(&file).await.unwrap();
        assert!(cache.results.lock().unwrap().is_empty());
        let batch = RecordBatch::try_from_iter(vec![("id", Arc::new(Int64Array::from(vec![9])) as ArrayRef)]).unwrap();
        write_parquet(&path, &batch, None);
        assert_eq!(super::count_data(&cache, &file, filter).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn result_cache_is_bounded_and_excludes_time_and_randomness() {
        let path = temp_path("bounded_count.parquet");
        write_small(&path);
        let file = path.to_string_lossy();
        let cache = ParquetCache::new();
        for i in 0..super::RESULT_CACHE_ENTRIES + 2 {
            super::count_data(&cache, &file, Some(format!("id > {i}"))).await.unwrap();
        }
        assert_eq!(cache.results.lock().unwrap().len(), super::RESULT_CACHE_ENTRIES);
        let ctx = cache.get_or_create_session(&file).await.unwrap();
        for query in [
            "SELECT COUNT(*) FROM t WHERE random() < 0.5",
            "SELECT COUNT(*) FROM t WHERE now() > TIMESTAMP '2000-01-01'",
            "SELECT COUNT(*) FROM t WHERE id IN (SELECT id FROM t WHERE random() < 0.5)",
        ] {
            let plan = super::plan_query_checked(&ctx, query).await.unwrap();
            assert!(!super::reusable_plan(&plan).unwrap(), "{query}");
            super::execute_browse_query(&cache, &file, query).await.unwrap();
            assert!(!cache.results.lock().unwrap().iter().any(|r| r.query == query));
        }
    }

    /// Glob characters are legal in file names; they must not be treated as
    /// a pattern over the parent directory.
    #[tokio::test]
    async fn reads_files_whose_names_contain_glob_characters() {
        for name in [
            "glob[1].parquet",
            "what?.parquet",
            "star*.parquet",
            "sp ace.parquet",
            "pct%20.parquet",
        ] {
            let path = temp_path("globs").join(name);
            write_small(&path);
            let cache = ParquetCache::new();
            let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 10, None, None)
                .await
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(rows.len(), 3, "{name}");
        }
    }

    #[tokio::test]
    async fn sql_view_refuses_statements_that_would_change_the_session() {
        let path = temp_path("readonly.parquet");
        write_small(&path);
        let cache = ParquetCache::new();
        let file = path.to_string_lossy().to_string();
        let run = |q: &'static str| {
            let cache = &cache;
            let file = file.clone();
            async move {
                super::execute_sql_limited(cache, &file, q, Some(10))
                    .await
                    .map(|(b, _, _)| b)
            }
        };

        for q in [
            "DROP TABLE t",
            "CREATE TABLE x AS SELECT * FROM t",
            "SET datafusion.execution.target_partitions = 8",
            "COPY (SELECT * FROM t) TO '/tmp/parqsee-must-not-exist.csv'",
            "CREATE EXTERNAL TABLE o STORED AS PARQUET LOCATION '/tmp/x.parquet'",
            "INSERT INTO t VALUES (1)",
        ] {
            let err = run(q).await.expect_err(q);
            assert!(err.contains("read-only"), "{q}: {err}");
        }
        assert!(!std::path::Path::new("/tmp/parqsee-must-not-exist.csv").exists());

        // The table survived the attempts, and plain reads still work.
        let rows = super::read_data(&cache, &file, 0, 10, None, None).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            run("SELECT * FROM t LIMIT 100;")
                .await
                .unwrap()
                .iter()
                .map(|b| b.num_rows())
                .sum::<usize>(),
            3
        );
        assert!(
            run("EXPLAIN SELECT * FROM t").await.is_ok(),
            "EXPLAIN must not be limited"
        );
        assert!(run("SHOW TABLES").await.is_ok(), "information_schema is on");
    }

    /// u64 hash columns and i64 sentinels put row-group statistics at the
    /// type limits; filtering such a file must not trip DataFusion's
    /// selectivity arithmetic.
    #[tokio::test]
    async fn filters_work_on_files_with_values_at_the_64_bit_limits() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("hash", DataType::UInt64, false),
            Field::new("id", DataType::Int64, false),
            Field::new("score", DataType::Float32, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(arrow::array::UInt64Array::from(vec![u64::MAX, 1, 0])) as ArrayRef,
                Arc::new(Int64Array::from(vec![i64::MIN, i64::MAX, 7])),
                Arc::new(arrow::array::Float32Array::from(vec![1.5, 2.5, 3.5])),
            ],
        )
        .unwrap();
        let path = temp_path("limits.parquet");
        write_parquet(&path, &batch, None);

        let cache = ParquetCache::new();
        let file = path.to_string_lossy().to_string();
        for (filter, expected) in [
            ("\"hash\" = 1", 1),
            ("\"score\" = 1.5", 1),
            ("\"id\" = 7", 1),
            ("\"hash\" = 18446744073709551615", 1),
        ] {
            let rows = super::read_data(&cache, &file, 0, 10, Some(filter.to_string()), None)
                .await
                .unwrap_or_else(|e| panic!("{filter}: {e}"));
            assert_eq!(rows.len(), expected, "{filter}");
            assert_eq!(
                super::count_data(&cache, &file, Some(filter.to_string()))
                    .await
                    .unwrap(),
                expected,
                "{filter}"
            );
        }
    }

    /// Unfiltered pages come from the parquet reader, filtered ones from
    /// DataFusion; the grid must not change shape or order when a filter is
    /// added, so both paths must paginate the same sequence identically —
    /// across row-group boundaries, at the tail, and past the end.
    #[tokio::test]
    async fn unfiltered_pages_match_the_sql_path() {
        use arrow::array::{BooleanArray, Float64Array, TimestampMillisecondArray};
        use parquet::file::properties::WriterProperties;

        let n: usize = 10;
        let mut tags = ListBuilder::new(Int32Builder::new());
        for i in 0..n as i32 {
            tags.values().append_value(i);
            tags.values().append_value(i * 10);
            tags.append(true);
        }
        let tags = tags.finish();
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("x", DataType::Float64, true),
            Field::new(
                "ts",
                DataType::Timestamp(arrow::datatypes::TimeUnit::Millisecond, None),
                true,
            ),
            Field::new("amount", DataType::Decimal128(12, 3), true),
            Field::new("ok", DataType::Boolean, true),
            Field::new("tags", tags.data_type().clone(), true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int64Array::from((0..n as i64).collect::<Vec<_>>())) as ArrayRef,
                Arc::new(StringArray::from(
                    (0..n)
                        .map(|i| {
                            if i % 3 == 0 {
                                None
                            } else {
                                Some(format!("row {i}"))
                            }
                        })
                        .collect::<Vec<_>>(),
                )),
                Arc::new(Float64Array::from(
                    (0..n)
                        .map(|i| if i == 4 { f64::NAN } else { i as f64 / 4.0 })
                        .collect::<Vec<_>>(),
                )),
                Arc::new(TimestampMillisecondArray::from(
                    (0..n)
                        .map(|i| Some(1_700_000_000_000 + i as i64 * 3_600_000))
                        .collect::<Vec<_>>(),
                )),
                Arc::new(
                    Decimal128Array::from(
                        (0..n).map(|i| Some(i as i128 * 1_001)).collect::<Vec<_>>(),
                    )
                    .with_precision_and_scale(12, 3)
                    .unwrap(),
                ),
                Arc::new(BooleanArray::from(
                    (0..n)
                        .map(|i| if i % 4 == 0 { None } else { Some(i % 2 == 0) })
                        .collect::<Vec<_>>(),
                )),
                Arc::new(tags),
            ],
        )
        .unwrap();
        let path = temp_path("pages.parquet");
        let props = WriterProperties::builder()
            .set_max_row_group_row_count(Some(4))
            .build();
        write_parquet(&path, &batch, Some(props));

        let cache = ParquetCache::new();
        let file = path.to_string_lossy().to_string();
        // (offset, limit): inside one row group, across a boundary, the tail
        // clipped by the end, an empty page past the end, and everything.
        for (offset, limit) in [(0, 3), (2, 5), (8, 5), (10, 5), (42, 1), (0, 100)] {
            let direct = super::read_data(&cache, &file, offset, limit, None, None)
                .await
                .unwrap();
            let via_sql = super::read_data(&cache, &file, offset, limit, Some("1 = 1".into()), None)
                .await
                .unwrap();
            assert_eq!(direct, via_sql, "offset {offset} limit {limit}");
            let expected = n.saturating_sub(offset).min(limit);
            assert_eq!(direct.len(), expected, "offset {offset} limit {limit}");
            if let Some(first) = direct.first() {
                assert_eq!(first["id"], serde_json::json!(offset as i64));
            }
        }
        // Spot-check the JSON-unsafe values survived the direct path too, and
        // that the NaN did not drag its finite neighbours into strings.
        let all = super::read_data(&cache, &file, 0, n, None, None).await.unwrap();
        assert_eq!(all[4]["x"], serde_json::json!("NaN"));
        assert_eq!(all[3]["x"], serde_json::json!(0.75));
        assert_eq!(all[1]["amount"], serde_json::json!("1.001"));
        assert_eq!(all[0]["name"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn duplicate_column_names_are_refused_when_opening() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("id", DataType::Utf8, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int64Array::from(vec![1])) as ArrayRef,
                Arc::new(StringArray::from(vec!["x"])),
            ],
        )
        .unwrap();
        let path = temp_path("dup.parquet");
        write_parquet(&path, &batch, None);

        let err = ParquetCache::new()
            .get_or_create_metadata(&path.to_string_lossy())
            .await
            .unwrap_err();
        assert!(err.contains("more than one column named \"id\""), "{err}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn eviction_cannot_reinsert_metadata_created_before_it() {
        let cache = Arc::new(ParquetCache::new());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let creating_cache = Arc::clone(&cache);

        let creation = tokio::spawn(async move {
            creating_cache
                .get_or_create_metadata_with("same-path", move || {
                    started_tx
                        .send(())
                        .expect("test must receive creation signal");
                    release_rx
                        .recv()
                        .expect("test must release metadata creation");
                    Ok(ParquetMetadata {
                        num_rows: 1,
                        num_columns: 0,
                        columns: vec![],
                    })
                })
                .await
        });

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("metadata creation must begin");

        let evicting_cache = Arc::clone(&cache);
        let mut eviction = tokio::spawn(async move { evicting_cache.evict("same-path").await });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut eviction)
                .await
                .is_err(),
            "eviction must wait for the in-flight creation before removing its result"
        );

        release_tx
            .send(())
            .expect("metadata creation must still be waiting");
        assert!(creation.await.expect("creation task must complete").is_ok());
        assert!(eviction.await.expect("eviction task must complete").is_ok());
        assert!(
            !cache
                .metadata
                .lock()
                .expect("metadata cache lock")
                .contains_key("same-path"),
            "an eviction issued during creation must leave no stale metadata behind"
        );
    }

    /// The sandbox grant for a file lives exactly as long as its cache entry.
    #[tokio::test]
    async fn a_cache_entry_holds_the_files_grant_until_evicted() {
        use crate::services::access::fake::FakeBookmarks;
        use crate::services::access::FileAccess;

        let path = temp_path("granted.parquet");
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![Field::new("v", DataType::Int32, false)])),
            vec![Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef],
        )
        .unwrap();
        write_parquet(&path, &batch, None);
        let path = path.to_string_lossy().into_owned();

        let fake = FakeBookmarks::default();
        let access = Arc::new(FileAccess::load(Box::new(fake.clone()), None));
        // Recorded in an earlier session, so the cache has to resolve it.
        access.remember_file(&path).unwrap();
        access.release(&path);
        assert!(fake.active().is_empty());

        let cache = ParquetCache::with_access(access);
        cache.get_or_create_metadata(&path).await.unwrap();
        assert_eq!(
            fake.active(),
            std::slice::from_ref(&path),
            "filling the metadata entry resolves the bookmark"
        );
        cache.get_or_create_session(&path).await.unwrap();
        cache.get_or_create_metadata(&path).await.unwrap();
        assert_eq!(
            fake.starts(),
            2,
            "the session fill reuses the held grant; hits do not touch it"
        );

        cache.evict(&path).await.unwrap();
        assert!(fake.active().is_empty(), "eviction ends the grant");
        assert_eq!(fake.stops(), 2);
    }

    /// A cache over `FakeBookmarks`, with `path` recorded in an earlier
    /// session and its grant released — the shape a Recent Files or session
    /// entry has at launch, where a fill has to resolve the bookmark itself.
    fn cache_over_recorded_file(
        path: &str,
    ) -> (ParquetCache, crate::services::access::fake::FakeBookmarks) {
        use crate::services::access::fake::FakeBookmarks;
        use crate::services::access::FileAccess;

        let fake = FakeBookmarks::default();
        let access = Arc::new(FileAccess::load(Box::new(fake.clone()), None));
        access.remember_file(path).unwrap();
        access.release(path);
        assert!(fake.active().is_empty());
        // `remember_file` resolved the bookmark once to hold it; every
        // count below starts from that (1 start, 1 stop).
        assert_eq!((fake.starts(), fake.stops()), (1, 1));
        (ParquetCache::with_access(access), fake)
    }

    /// A recorded file whose contents are no longer a Parquet file.
    fn corrupt_recorded_file(name: &str) -> String {
        let path = temp_path(name);
        std::fs::write(&path, b"not a parquet file at all").unwrap();
        path.to_string_lossy().into_owned()
    }

    /// A fill that fails leaves no grant behind: the file has no tab, so
    /// nothing would ever evict it. Repeating the open must not pile up
    /// resolves either.
    #[tokio::test]
    async fn a_failed_metadata_fill_gives_back_the_grant_it_took() {
        let path = corrupt_recorded_file("broken-meta.parquet");
        let (cache, fake) = cache_over_recorded_file(&path);

        for attempt in 1..=2 {
            cache.get_or_create_metadata(&path).await.unwrap_err();
            assert!(
                fake.active().is_empty(),
                "attempt {attempt} left a grant behind"
            );
            assert_eq!(fake.starts(), 1 + attempt, "the fill resolved the bookmark");
            assert_eq!(
                fake.stops(),
                1 + attempt,
                "and gave it back when the decode failed"
            );
        }
        assert!(cache.metadata.lock().unwrap().is_empty());
        assert!(cache.sessions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_session_fill_gives_back_the_grant_when_nothing_else_holds_it() {
        let path = corrupt_recorded_file("broken-session.parquet");
        let (cache, fake) = cache_over_recorded_file(&path);

        assert!(cache.get_or_create_session(&path).await.is_err());
        assert!(fake.active().is_empty());
        assert_eq!((fake.starts(), fake.stops()), (2, 2));
        assert!(cache.sessions.lock().unwrap().is_empty());
    }

    /// The metadata entry (a tab) still needs the grant when the session
    /// half fails, so that failure must not take it away.
    #[tokio::test]
    async fn a_failed_session_fill_keeps_the_grant_the_metadata_entry_holds() {
        let path = corrupt_recorded_file("meta-ok-session-broken.parquet");
        let (cache, fake) = cache_over_recorded_file(&path);

        cache
            .get_or_create_metadata_with(&path, || {
                Ok(ParquetMetadata {
                    num_rows: 0,
                    num_columns: 0,
                    columns: vec![],
                })
            })
            .await
            .unwrap();
        assert_eq!(fake.active(), std::slice::from_ref(&path));

        assert!(cache.get_or_create_session(&path).await.is_err());
        assert_eq!(
            fake.active(),
            std::slice::from_ref(&path),
            "the tab's grant survives the session failure"
        );
        assert_eq!((fake.starts(), fake.stops()), (2, 1));

        cache.evict(&path).await.unwrap();
        assert!(fake.active().is_empty());
        assert_eq!((fake.starts(), fake.stops()), (2, 2));
    }

    /// Both halves fill under separate gates, so one can fail while the
    /// other is still creating its entry. The failure must leave the grant
    /// to the fill in flight, whichever side it is on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fill_failing_beside_an_in_flight_fill_leaves_the_grant_to_it() {
        // The session fill fails while the metadata fill is still computing.
        let path = corrupt_recorded_file("session-fails-first.parquet");
        let (cache, fake) = cache_over_recorded_file(&path);
        let cache = Arc::new(cache);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<Result<(), String>>();
        let creation = {
            let cache = Arc::clone(&cache);
            let path = path.clone();
            tokio::spawn(async move {
                cache
                    .get_or_create_metadata_with(&path, move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap()?;
                        Ok(ParquetMetadata {
                            num_rows: 0,
                            num_columns: 0,
                            columns: vec![],
                        })
                    })
                    .await
            })
        };
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("metadata creation must begin");
        assert_eq!(
            fake.active(),
            std::slice::from_ref(&path),
            "the metadata fill holds the grant"
        );

        assert!(cache.get_or_create_session(&path).await.is_err());
        assert_eq!(
            fake.active(),
            std::slice::from_ref(&path),
            "the in-flight metadata fill still needs it"
        );
        assert_eq!((fake.starts(), fake.stops()), (2, 1));

        release_tx.send(Ok(())).unwrap();
        creation.await.unwrap().unwrap();
        assert_eq!(fake.active(), std::slice::from_ref(&path));
        cache.evict(&path).await.unwrap();
        assert!(fake.active().is_empty());
        assert_eq!((fake.starts(), fake.stops()), (2, 2));

        // The metadata fill fails after the session fill completed beside it.
        let path = temp_path("meta-fails-last.parquet");
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![Field::new("v", DataType::Int32, false)])),
            vec![Arc::new(Int32Array::from(vec![1])) as ArrayRef],
        )
        .unwrap();
        write_parquet(&path, &batch, None);
        let path = path.to_string_lossy().into_owned();
        let (cache, fake) = cache_over_recorded_file(&path);
        let cache = Arc::new(cache);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<Result<(), String>>();
        let creation = {
            let cache = Arc::clone(&cache);
            let path = path.clone();
            tokio::spawn(async move {
                cache
                    .get_or_create_metadata_with(&path, move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap()?;
                        Ok(ParquetMetadata {
                            num_rows: 0,
                            num_columns: 0,
                            columns: vec![],
                        })
                    })
                    .await
            })
        };
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("metadata creation must begin");
        cache.get_or_create_session(&path).await.unwrap();
        assert_eq!(fake.active(), std::slice::from_ref(&path));

        release_tx.send(Err("decode failed".into())).unwrap();
        creation.await.unwrap().unwrap_err();
        assert_eq!(
            fake.active(),
            std::slice::from_ref(&path),
            "the session entry still holds the grant"
        );
        assert_eq!((fake.starts(), fake.stops()), (2, 1));
        assert!(cache.metadata.lock().unwrap().is_empty());

        cache.evict(&path).await.unwrap();
        assert!(fake.active().is_empty());
        assert_eq!((fake.starts(), fake.stops()), (2, 2));
    }

    #[tokio::test]
    async fn date64_renders_as_a_date() {
        let schema = Arc::new(Schema::new(vec![Field::new("d", DataType::Date64, true)]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(arrow::array::Date64Array::from(vec![
                Some(1_709_164_800_000),
                None,
            ])) as ArrayRef],
        )
        .unwrap();
        let path = temp_path("date64.parquet");
        write_parquet(&path, &batch, None);

        let rows = super::read_data(&ParquetCache::new(), &path.to_string_lossy(), 0, 2, None, None)
            .await
            .unwrap();
        assert_eq!(rows[0]["d"], "2024-02-29");
    }

    #[test]
    fn page_query_covers_every_clause_combination() {
        use super::build_page_query;
        assert_eq!(
            build_page_query(None, None, Some(0), Some(50)),
            "SELECT * FROM t LIMIT 50"
        );
        assert_eq!(
            build_page_query(Some("  "), None, Some(100), Some(50)),
            "SELECT * FROM t LIMIT 50 OFFSET 100"
        );
        assert_eq!(
            build_page_query(Some("\"id\" > 1"), None, None, None),
            "SELECT * FROM t WHERE \"id\" > 1"
        );
        assert_eq!(
            build_page_query(Some("\"id\" > 1"), None, Some(25), Some(25)),
            "SELECT * FROM t WHERE \"id\" > 1 LIMIT 25 OFFSET 25"
        );
        assert_eq!(
            build_page_query(None, Some("\"a\" ASC NULLS LAST"), Some(25), Some(25)),
            "SELECT * FROM t ORDER BY \"a\" ASC NULLS LAST LIMIT 25 OFFSET 25"
        );
        assert_eq!(
            build_page_query(Some("\"id\" > 1"), Some("\"a\" DESC NULLS FIRST"), None, None),
            "SELECT * FROM t WHERE \"id\" > 1 ORDER BY \"a\" DESC NULLS FIRST"
        );
    }

    fn columns_of(specs: &[(&str, ColumnKind)]) -> Vec<ColumnInfo> {
        specs
            .iter()
            .map(|(name, kind)| ColumnInfo {
                name: name.to_string(),
                column_type: String::new(),
                kind: *kind,
                logical_type: None,
                physical_type: String::new(),
            })
            .collect()
    }

    /// A sorted page whose top-k heap outgrows the session's memory limit
    /// fails with a message that names the way out, and leaves the file's
    /// unsorted and filtered pages untouched.
    #[tokio::test]
    async fn a_sort_past_the_memory_limit_fails_cleanly() {
        let path = temp_path("sort_memory.parquet");
        let n = 2000i64;
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("id", DataType::Int64, false),
                Field::new("name", DataType::Utf8, true),
            ])),
            vec![
                Arc::new(Int64Array::from((0..n).collect::<Vec<_>>())) as ArrayRef,
                Arc::new(StringArray::from(
                    (0..n).map(|i| Some(format!("row {i:04}"))).collect::<Vec<_>>(),
                )),
            ],
        )
        .unwrap();
        write_parquet(&path, &batch, None);
        let file = path.to_string_lossy().to_string();
        let cache = ParquetCache::new().with_memory_limit(4 * 1024);
        let sort = || {
            Some(SortSpec {
                column: "name".into(),
                direction: SortDirection::Asc,
            })
        };

        let err = super::read_data(&cache, &file, 500, 50, None, sort()).await.unwrap_err();
        assert!(err.contains("too deep into the sort"), "{err}");
        let plain = super::read_data(&cache, &file, 500, 50, None, None).await.unwrap();
        assert_eq!(plain[0]["id"], 500);
        let filtered = super::read_data(&cache, &file, 0, 5, Some("\"id\" > 1990".into()), None)
            .await
            .unwrap();
        assert_eq!(filtered.len(), 5);
    }

    #[test]
    fn deep_pages_are_read_from_the_far_end() {
        use super::mirrored_window;
        // The near half, the midpoint included, is read as it is.
        assert_eq!(mirrored_window(0, 7, 61), None);
        assert_eq!(mirrored_window(30, 7, 61), None);
        // Past the midpoint: the same rows counted from the other end.
        assert_eq!(mirrored_window(31, 7, 61), Some((23, 7)));
        assert_eq!(mirrored_window(49, 7, 61), Some((5, 7)));
        // The last page is clipped by the end, so it starts the reversed order.
        assert_eq!(mirrored_window(56, 7, 61), Some((0, 5)));
        // Past the end there is nothing to mirror (the query answers empty).
        assert_eq!(mirrored_window(61, 7, 61), None);
        assert_eq!(mirrored_window(70, 7, 61), None);
        assert_eq!(mirrored_window(0, 7, 0), None);
    }

    #[test]
    fn order_by_puts_the_key_first_and_every_sortable_column_after_it() {
        use super::order_by_terms;
        let columns = columns_of(&[
            ("id", ColumnKind::Integer),
            ("Mixed \"q\"", ColumnKind::Text),
            ("tags", ColumnKind::Nested),
            ("span", ColumnKind::Other),
            ("x", ColumnKind::Float),
        ]);
        let by = |column: &str, direction| SortSpec { column: column.into(), direction };

        assert_eq!(
            order_by_terms(&by("Mixed \"q\"", SortDirection::Asc), &columns).unwrap(),
            "\"Mixed \"\"q\"\"\" ASC NULLS LAST, \"id\" ASC NULLS LAST, \"x\" ASC NULLS LAST"
        );
        assert_eq!(
            order_by_terms(&by("x", SortDirection::Desc), &columns).unwrap(),
            "\"x\" DESC NULLS FIRST, \"id\" DESC NULLS FIRST, \"Mixed \"\"q\"\"\" DESC NULLS FIRST"
        );
        let err = order_by_terms(&by("nope", SortDirection::Asc), &columns).unwrap_err();
        assert!(err.contains("nope") && err.contains("no such column"), "{err}");
        let err = order_by_terms(&by("tags", SortDirection::Asc), &columns).unwrap_err();
        assert!(err.contains("tags") && err.contains("no order"), "{err}");
    }

    /// A sort key with long runs of equal values — the shape a category
    /// column has — read page by page, each page its own `ORDER BY ... LIMIT
    /// / OFFSET` query. The pages must join up into one sequence: no row
    /// twice, none missing, ties in a fixed order. A nested column rides
    /// along outside the key, and NULLs go last ascending, first descending.
    #[tokio::test]
    async fn sorted_pages_join_up_without_repeating_or_losing_a_row() {
        use parquet::file::properties::WriterProperties;

        let n: usize = 61;
        let grp = |i: usize| match i % 3 {
            0 => Some("b"),
            1 => Some("a"),
            _ => None,
        };
        let mut tags = ListBuilder::new(Int32Builder::new());
        for i in 0..n as i32 {
            tags.values().append_value(i);
            tags.append(true);
        }
        let tags = tags.finish();
        let schema = Arc::new(Schema::new(vec![
            Field::new("grp", DataType::Utf8, true),
            Field::new("id", DataType::Int64, false),
            Field::new("tags", tags.data_type().clone(), true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from((0..n).map(grp).collect::<Vec<_>>())) as ArrayRef,
                Arc::new(Int64Array::from((0..n as i64).collect::<Vec<_>>())),
                Arc::new(tags),
            ],
        )
        .unwrap();
        let path = temp_path("sorted_pages.parquet");
        let props = WriterProperties::builder()
            .set_max_row_group_row_count(Some(8))
            .build();
        write_parquet(&path, &batch, Some(props));

        let cache = ParquetCache::new();
        let file = path.to_string_lossy().to_string();
        let sort = |direction| {
            Some(SortSpec {
                column: "grp".into(),
                direction,
            })
        };
        let ids = |rows: &[serde_json::Value]| rows.iter().map(|r| r["id"].as_i64().unwrap()).collect::<Vec<_>>();

        // Ascending by (grp NULLS LAST, id): every "a" row, then every "b"
        // row, then the NULLs, each run in id order.
        let mut expected: Vec<(u8, i64)> = (0..n)
            .map(|i| (grp(i).map_or(2, |g| if g == "a" { 0 } else { 1 }), i as i64))
            .collect();
        expected.sort();
        let expected: Vec<i64> = expected.into_iter().map(|(_, id)| id).collect();

        for page_size in [7usize, 10, 100] {
            let mut joined = Vec::new();
            let mut offset = 0;
            loop {
                let page = super::read_data(&cache, &file, offset, page_size, None, sort(SortDirection::Asc))
                    .await
                    .unwrap();
                if page.is_empty() {
                    break;
                }
                joined.extend(page);
                offset += page_size;
            }
            assert_eq!(ids(&joined), expected, "pages of {page_size}");
            // The nested column came along with its row.
            for row in &joined {
                assert_eq!(row["tags"][0], row["id"]);
            }
        }

        // Descending is the ascending sequence reversed, NULLs first.
        let desc = super::read_data(&cache, &file, 0, n, None, sort(SortDirection::Desc))
            .await
            .unwrap();
        let mut reversed = expected.clone();
        reversed.reverse();
        assert_eq!(ids(&desc), reversed);
        assert!(desc[0]["grp"].is_null());

        // Under a filter the sort walks the filtered rows the same way.
        let filter = Some("\"id\" % 2 = 0".to_string());
        let mut joined = Vec::new();
        let mut offset = 0;
        loop {
            let page = super::read_data(&cache, &file, offset, 5, filter.clone(), sort(SortDirection::Asc))
                .await
                .unwrap();
            if page.is_empty() {
                break;
            }
            joined.extend(page);
            offset += 5;
        }
        let expected_even: Vec<i64> = expected.iter().copied().filter(|id| id % 2 == 0).collect();
        assert_eq!(ids(&joined), expected_even);

        // A sort the file cannot answer names the column rather than failing
        // deep inside the query.
        let err = super::read_data(
            &cache,
            &file,
            0,
            5,
            None,
            Some(SortSpec {
                column: "gone".into(),
                direction: SortDirection::Asc,
            }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("gone"), "{err}");
    }

    #[tokio::test]
    async fn integers_past_the_js_safe_range_arrive_as_strings() {
        let inner_fields: Fields = vec![Field::new("big", DataType::Int64, true)].into();
        let nested = StructArray::new(
            inner_fields.clone(),
            vec![Arc::new(Int64Array::from(vec![9007199254740993i64, 0])) as ArrayRef],
            None,
        );
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("small", DataType::Int64, false),
            Field::new("nested", DataType::Struct(inner_fields), true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int64Array::from(vec![
                    9007199254740993i64,
                    -9007199254740993i64,
                ])) as ArrayRef,
                Arc::new(Int64Array::from(vec![42i64, 9007199254740991i64])),
                Arc::new(nested),
            ],
        )
        .unwrap();
        let path = temp_path("big_ints.parquet");
        write_parquet(&path, &batch, None);

        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 2, None, None)
            .await
            .unwrap();

        assert_eq!(rows[0]["id"], "9007199254740993");
        assert_eq!(rows[1]["id"], "-9007199254740993");
        // The schema gate must see through containers.
        assert_eq!(rows[0]["nested"]["big"], "9007199254740993");
        // Values JS represents exactly stay numbers.
        assert_eq!(rows[0]["small"], 42);
        assert_eq!(rows[1]["small"], 9007199254740991i64);
    }

    #[tokio::test]
    async fn metadata_classifies_primitive_columns_structurally() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("flag", DataType::Boolean, false),
            Field::new("n", DataType::Int64, false),
            Field::new("x", DataType::Float64, false),
            Field::new("amount", DataType::Decimal128(20, 4), false),
            Field::new("d", DataType::Date32, false),
            Field::new(
                "ts",
                DataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, None),
                false,
            ),
            Field::new("name", DataType::Utf8, false),
            Field::new("blob", DataType::Binary, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(arrow::array::BooleanArray::from(vec![true])) as ArrayRef,
                Arc::new(Int64Array::from(vec![1])),
                Arc::new(arrow::array::Float64Array::from(vec![1.5])),
                Arc::new(
                    Decimal128Array::from(vec![1i128])
                        .with_precision_and_scale(20, 4)
                        .unwrap(),
                ),
                Arc::new(arrow::array::Date32Array::from(vec![19000])),
                Arc::new(arrow::array::TimestampMicrosecondArray::from(vec![0i64])),
                Arc::new(StringArray::from(vec!["a"])),
                Arc::new(arrow::array::BinaryArray::from(vec![&[0u8][..]])),
            ],
        )
        .unwrap();
        let path = temp_path("kinds.parquet");
        write_parquet(&path, &batch, None);

        let meta = ParquetCache::new()
            .get_or_create_metadata(&path.to_string_lossy())
            .await
            .unwrap();
        let kinds: Vec<ColumnKind> = meta.columns.iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ColumnKind::Boolean,
                ColumnKind::Integer,
                ColumnKind::Float,
                ColumnKind::Decimal,
                ColumnKind::Temporal,
                ColumnKind::Temporal,
                ColumnKind::Text,
                ColumnKind::Binary,
            ]
        );
    }

    #[tokio::test]
    async fn metadata_labels_group_columns_instead_of_panicking() {
        let path = write_nested_fixture();
        let cache = ParquetCache::new();
        let meta = cache
            .get_or_create_metadata(&path.to_string_lossy())
            .await
            .expect("nested schemas must not fail metadata");

        assert_eq!(meta.num_columns, 3);
        assert_eq!(meta.columns[0].column_type, "STRING");
        assert_eq!(meta.columns[0].kind, ColumnKind::Text);
        assert_eq!(meta.columns[1].column_type, "LIST");
        assert_eq!(meta.columns[1].physical_type, "LIST");
        assert_eq!(meta.columns[1].kind, ColumnKind::Nested);
        assert_eq!(meta.columns[2].column_type, "STRUCT");
        assert_eq!(meta.columns[2].physical_type, "STRUCT");
        assert_eq!(meta.columns[2].kind, ColumnKind::Nested);
    }

    fn batch(n: i32) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int32, false)]));
        RecordBatch::try_new(schema, vec![Arc::new(Int32Array::from_iter_values(0..n))]).unwrap()
    }

    fn rows(batches: &[RecordBatch]) -> usize {
        batches.iter().map(|b| b.num_rows()).sum()
    }

    #[test]
    fn metadata_is_derived_from_the_schema_alone() {
        use parquet::basic::{LogicalType, Repetition, Type as PhysicalType};
        use parquet::schema::types::Type;

        let primitive = |name: &str, physical, logical: Option<LogicalType>| {
            Type::primitive_type_builder(name, physical)
                .with_repetition(Repetition::OPTIONAL)
                .with_logical_type(logical)
                .build()
                .unwrap()
        };
        let root = |fields: Vec<Type>| {
            Type::group_type_builder("schema")
                .with_fields(fields.into_iter().map(Arc::new).collect())
                .build()
                .unwrap()
        };

        let meta = super::metadata_from_schema(
            &root(vec![
                primitive("id", PhysicalType::INT64, None),
                primitive("name", PhysicalType::BYTE_ARRAY, Some(LogicalType::String)),
            ]),
            7,
        )
        .unwrap();
        assert_eq!(meta.num_rows, 7);
        assert_eq!(meta.num_columns, 2);
        assert_eq!(meta.columns[0].column_type, "INT64");
        assert_eq!(meta.columns[0].kind, ColumnKind::Integer);
        assert_eq!(meta.columns[1].column_type, "STRING");
        assert_eq!(meta.columns[1].physical_type, "BYTE_ARRAY");

        let err = super::metadata_from_schema(
            &root(vec![
                primitive("id", PhysicalType::INT64, None),
                primitive("id", PhysicalType::INT32, None),
            ]),
            0,
        )
        .unwrap_err();
        assert!(err.contains("more than one column named \"id\""), "{err}");
    }

    #[test]
    fn count_is_read_from_the_first_non_empty_batch() {
        use arrow::array::Int64Array;
        let schema = Arc::new(Schema::new(vec![Field::new("c", DataType::Int64, false)]));
        let count = |values: Vec<i64>| {
            RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(values))]).unwrap()
        };
        assert_eq!(super::count_from_batches(&[]).unwrap(), 0);
        assert_eq!(super::count_from_batches(&[count(vec![])]).unwrap(), 0);
        assert_eq!(
            super::count_from_batches(&[count(vec![]), count(vec![42])]).unwrap(),
            42
        );
        assert!(super::count_from_batches(&[count(vec![-1])]).is_err());
        assert!(
            super::count_from_batches(&[batch(1)]).is_err(),
            "an Int32 column is not a count"
        );
    }

    #[test]
    fn keeps_results_within_the_limit() {
        let (batches, truncated) = truncate_batches(vec![batch(3), batch(4)], 7);
        assert!(!truncated);
        assert_eq!(rows(&batches), 7);
        let (batches, truncated) = truncate_batches(batches, 100);
        assert!(!truncated);
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn cuts_inside_a_batch_and_drops_the_rest() {
        let (batches, truncated) = truncate_batches(vec![batch(3), batch(4), batch(5)], 5);
        assert!(truncated);
        assert_eq!(batches.len(), 2);
        assert_eq!(rows(&batches), 5);
        assert_eq!(batches[1].num_rows(), 2);
    }

    #[test]
    fn cuts_exactly_on_a_batch_boundary() {
        let (batches, truncated) = truncate_batches(vec![batch(3), batch(4)], 3);
        assert!(truncated);
        assert_eq!(batches.len(), 1);
        assert_eq!(rows(&batches), 3);
    }

    #[test]
    fn zero_limit_drops_everything() {
        let (batches, truncated) = truncate_batches(vec![batch(3)], 0);
        assert!(truncated);
        assert!(batches.is_empty());
    }
}
