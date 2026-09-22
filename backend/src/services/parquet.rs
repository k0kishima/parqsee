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
/// "Resources exhausted", which the grid turns into a message that
/// names the way out. When the sorted page's query still carried every
/// column of the row, measured on a 58M-row, 7-column file in release,
/// the page at offset 1M peaked at 2.1 GB of process memory, at 5M at
/// 3.3 GB, at the middle (29M) at 12.9 GB — the heap held `offset + limit`
/// whole rows. The heap now holds the key and a row position
/// (`SortOrder`), deep pages prefer a spillable ordinary sort
/// (`prefer_full_page_sort`) and a top-k that hits the limit falls back
/// to it (`sorted_rows`), so the limit is reached far later; it still
/// keeps a page of a huge file from taking the app down on a small
/// machine, since even a spilling sort needs memory for its merge batches.
pub const SESSION_MEMORY_LIMIT: usize = 2 * 1024 * 1024 * 1024;

/// Whether a query failed because it wanted more than `SESSION_MEMORY_LIMIT`.
/// DataFusion reports the memory pool's refusal as a `ResourcesExhausted`
/// error, and by the time a query's error reaches a caller here it is a
/// `String`, so the wording is all there is to go on. It decides both what
/// the user is told (the grid and an export each name their own way out)
/// and whether a top-k retries as the spillable full sort, which is why
/// the three callers must agree on it: a wording that stopped matching
/// would turn the retry into a plain failure without any test noticing
/// the message changed.
pub fn is_memory_exhausted(error: &str) -> bool {
    error.contains("Resources exhausted")
}

// Shared across files, not an additional allowance for every open tab.
const RESULT_CACHE_BYTES: usize = 32 * 1024 * 1024;
const RESULT_CACHE_ENTRIES: usize = 64;
/// A result this long or shorter is a page the grid could ask for again.
/// A larger range is a one-off — an export, a custom range — and holding
/// it would push out the pages the grid is actually paging through.
const RESULT_CACHE_MAX_ROWS: usize = 8192;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResultCachePolicy {
    Populate,
    ReuseOnly,
}

#[derive(Clone, PartialEq, Eq)]
struct FileVersion {
    size: u64,
    modified: std::time::SystemTime,
}

impl FileVersion {
    // Call only after a metadata/session fill has acquired sandbox access.
    fn read(path: &str) -> Result<Self, String> {
        // Worded like the reader's own failure: opening a file is where this
        // is reached first, and a file that is gone or unreadable must read
        // the same on the error screen whichever of the two noticed.
        let metadata = std::fs::metadata(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
        Ok(Self {
            size: metadata.len(),
            modified: metadata.modified().map_err(|e| format!("Cannot read modification time for {path}: {e}"))?,
        })
    }

    fn check(&self, path: &str) -> Result<(), String> {
        if Self::read(path)? != *self {
            return Err("The file changed while reading it. Refresh and try again.".into());
        }
        Ok(())
    }
}

struct CachedResult {
    path: String,
    session_id: String,
    version: FileVersion,
    query: String,
    batches: Vec<RecordBatch>,
    bytes: usize,
}

pub struct ParquetCache {
    sessions: Mutex<HashMap<String, datafusion::execution::context::SessionContext>>,
    metadata: Mutex<HashMap<String, ParquetMetadata>>,
    /// The version of each open file at the moment it was opened. Every
    /// path that returns or writes rows — pages, counts, exports, profiles
    /// — compares it with the file on disk first and refuses to read when
    /// the two differ, because a file replaced under an open tab is a
    /// different file that nothing downstream would notice: the DataFusion
    /// session keeps the schema it registered, so its adapter quietly casts
    /// the new file's columns into the old shape and NULL-fills the ones it
    /// no longer has, while `range_reader` cuts the new file to the row
    /// count the old footer reported — page 1500 of a file that is now five
    /// rows long reads as no rows at all, under a footer still counting
    /// 100,000. A refresh (`evict`, then opening the file again) is the one
    /// way back, since only that re-reads the schema, the row count and this
    /// version together.
    versions: Mutex<HashMap<String, FileVersion>>,
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

/// A cached value for `path`, cloned out from under the lock. Both fills
/// look twice — once before taking the path's gate and once after, because
/// a concurrent miss may have finished while this call waited for it — so
/// the lookup is written here rather than four times over.
fn cached<T: Clone>(cache: &Mutex<HashMap<String, T>>, path: &str) -> Result<Option<T>, String> {
    let cache = cache.lock().map_err(|e| e.to_string())?;
    Ok(cache.get(path).cloned())
}

/// Put a filled value in, under the same lock discipline.
fn store<T>(cache: &Mutex<HashMap<String, T>>, path: &str, value: T) -> Result<(), String> {
    let mut cache = cache.lock().map_err(|e| e.to_string())?;
    cache.insert(path.to_string(), value);
    Ok(())
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
            versions: Mutex::new(HashMap::new()),
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
        if let Some(ctx) = cached(&self.sessions, path)? {
            return Ok(ctx);
        }

        let gate = self.session_gate(path)?;
        let _gate = gate.lock().await;

        // A concurrent miss may have completed while this call waited.
        if let Some(ctx) = cached(&self.sessions, path)? {
            return Ok(ctx);
        }

        // Create the session and register the parquet file. Single partition,
        // deliberately — see the trade-off note in this function's doc.
        self.access.acquire(path)?;
        let config = datafusion::execution::context::SessionConfig::new()
            .with_target_partitions(1)
            // Lets the SQL view answer SHOW TABLES / SHOW COLUMNS FROM t.
            .with_information_schema(true)
            // What a full sort keeps back for merging the batches it holds in
            // memory: the merge's cursors carry every buffered row's key in row
            // format, and that cannot spill. The default (10 MB) let the sorter
            // fill the pool with batches first — a sorted page of a 58M-row
            // file failed asking for 400 MB more once 44M rows were buffered.
            // Half the pool makes it spill while a merge of what is left
            // still fits, at the price of spilling sooner; the position query
            // a sorted page runs (`SortOrder`) is narrow enough that a spill
            // is cheap.
            .with_sort_spill_reservation_bytes(self.memory_limit / 2);
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

        // Only when nothing has recorded one yet: the metadata fill reads
        // the schema and the row count the tab shows, so its version is the
        // one every later read has to match.
        if let Err(e) = FileVersion::read(path).and_then(|version| {
            let mut versions = self.versions.lock().map_err(|e| e.to_string())?;
            versions.entry(path.to_string()).or_insert(version);
            Ok(())
        }) {
            self.release_unless_used(path, &self.metadata_gates);
            return Err(e);
        }

        store(&self.sessions, path, ctx.clone())?;

        Ok(ctx)
    }

    /// Get cached metadata, or compute and cache it.
    ///
    /// Reading the file's schema is also what opens it, so this is where the
    /// version every later read is held to is recorded. It is read before
    /// the schema and checked after it, so the two cannot straddle a
    /// rewrite: recording the version of a file whose row count came from
    /// the one before it would let every later page through against a
    /// footer that no longer describes it.
    pub async fn get_or_create_metadata(&self, path: &str) -> Result<ParquetMetadata, String> {
        self.get_or_create_metadata_with(path, || {
            let version = FileVersion::read(path)?;
            let meta = compute_metadata(path)?;
            version.check(path)?;
            store(&self.versions, path, version)?;
            Ok(meta)
        })
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
        if let Some(meta) = cached(&self.metadata, path)? {
            return Ok(meta);
        }

        let gate = self.metadata_gate(path)?;
        let _gate = gate.lock().await;

        // A concurrent miss may have completed while this call waited.
        if let Some(meta) = cached(&self.metadata, path)? {
            return Ok(meta);
        }

        self.access.acquire(path)?;
        let meta = match compute() {
            Ok(meta) => meta,
            Err(e) => {
                self.release_unless_used(path, &self.session_gates);
                return Err(e);
            }
        };

        store(&self.metadata, path, meta.clone())?;

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
            let mut results = self.results.lock().unwrap_or_else(|poisoned| {
                // Cached data is disposable. Recover without skipping the
                // metadata cleanup and sandbox grant release below.
                let mut results = poisoned.into_inner();
                results.clear();
                self.results.clear_poison();
                results
            });
            results.retain(|r| r.path != path);
        }
        if let Ok(mut metadata_cache) = self.metadata.lock() {
            metadata_cache.remove(path);
        }
        if let Ok(mut versions) = self.versions.lock() {
            versions.remove(path);
        }
        self.access.release(path);
        Ok(())
    }

    /// Refuse to read a file that changed since it was opened. A path with
    /// no recorded version is not open, and is read as it is found.
    pub fn check_unchanged(&self, path: &str) -> Result<(), String> {
        let recorded = {
            let versions = self.versions.lock().map_err(|e| e.to_string())?;
            versions.get(path).cloned()
        };
        match recorded {
            Some(version) => version.check(path),
            None => Ok(()),
        }
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

/// The same file opened for the Arrow reader instead: a page read by
/// range and a sorted page's read by position both build on it, and both
/// report a file they cannot open the same way.
fn open_reader_builder(path: &str) -> Result<ParquetRecordBatchReaderBuilder<File>, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {}", path, e))?;
    ParquetRecordBatchReaderBuilder::try_new(file)
        .map_err(|e| format!("Failed to open parquet file {}: {}", path, e))
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
    let builder = open_reader_builder(path)?;

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
        let arrow_kind = match field.data_type() {
            DataType::Date32
            | DataType::Date64
            | DataType::Time32(_)
            | DataType::Time64(_)
            | DataType::Timestamp(_, _) => ColumnKind::Temporal,
            // A duration is stored as a bare integer, but Arrow and
            // DataFusion read it back as Duration(unit), which no bare
            // number compares to: reported as an integer, the filter bar
            // would send `"dur" > 0` and the plan would fail on
            // `Duration(ns) > Int64`. Reported as Other, the bar quotes
            // what was typed and the header names the Arrow type, so the
            // unit the values carry is on screen.
            DataType::Duration(_) => ColumnKind::Other,
            _ => continue,
        };
        if column.kind != arrow_kind {
            column.kind = arrow_kind;
            column.column_type = format!("{:?}", field.data_type());
            // A duration carries no parquet annotation, so the header —
            // which names the logical type and falls back to the physical
            // one — would call it INT64 while the bar quotes its literals.
            // The Arrow type is the logical information the file lacks,
            // and it is what says which unit the values are counted in.
            if arrow_kind == ColumnKind::Other && column.logical_type.is_none() {
                column.logical_type = Some(column.column_type.clone());
            }
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
        DataType::Dictionary(_, value) => contains_json_unsafe(value),
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
        // The arms above match on the type of the values, which a dictionary
        // hides behind its keys; unpack it and convert what it encoded.
        DataType::Dictionary(_, value_type) => {
            let values = unpack_dictionary(array, value_type)?;
            json_unsafe_as_strings(&values)
        }
        // contains_json_unsafe only claims the container types handled above.
        _ => Ok(array.clone()),
    }
}

/// One dictionary-encoded column as an array of the values it encoded,
/// repeated per row.
fn unpack_dictionary(array: &ArrayRef, value_type: &DataType) -> Result<ArrayRef, String> {
    arrow::compute::cast(array, value_type)
        .map_err(|e| format!("Failed to unpack dictionary column: {}", e))
}

/// `batch` with every top-level dictionary column replaced by its values.
///
/// A dictionary is an encoding, not a type the grid shows: the same values
/// with their repetitions factored out. The conversions below match on the
/// type of the values — float, decimal, Date64 — and a dictionary hides that
/// type behind its keys, so a `Dictionary(Int32, Float64)` written by a
/// pandas categorical slipped past the float handling and its NaN and
/// infinities reached the webview as `null`, indistinguishable from a missing
/// value. Unpacking first puts every such column back on the ordinary path.
///
/// The repetitions come back with it, which is why this is confined to what
/// is about to be rendered — a page of at most a few thousand rows, or one
/// export batch — and never applied to a scan.
fn unpack_dictionaries(batch: &RecordBatch) -> Result<RecordBatch, String> {
    rebuild_columns(
        batch,
        |t| matches!(t, DataType::Dictionary(_, _)),
        |field, column| {
            let DataType::Dictionary(_, value_type) = column.data_type() else {
                return Ok((field.clone(), column.clone()));
            };
            let values = unpack_dictionary(column, value_type)?;
            Ok((retyped_field(field, values.data_type()), values))
        },
    )
}

/// Arrow's JSON writers refuse decimals outright, which used to fail the read
/// of any file carrying a money column, and they write NaN and ±Infinity as
/// `null`, which showed a pandas NaN as a missing value. Render both as
/// strings — exact, and distinguishable from NULL — print Date64 as the date
/// it is, and leave every other column alone.
pub fn json_unsafe_to_strings(batch: &RecordBatch) -> Result<RecordBatch, String> {
    convert_batch(&unpack_dictionaries(batch)?, false)
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

/// `batch` with every top-level Date64 column cast to Date32.
///
/// A Date64 is a date stored as milliseconds, and every writer that reads
/// the type rather than the value prints the time of day it never has:
/// arrow's CSV writer spells `2024-02-29` as `2024-02-29T00:00:00`. Casting
/// to Date32 first is the same conversion `json_unsafe_as_strings` applies
/// on the JSON path, so both exports and the grid show one date.
pub fn date64_as_date32(batch: &RecordBatch) -> Result<RecordBatch, String> {
    rebuild_columns(
        batch,
        |t| matches!(t, DataType::Date64),
        |field, column| {
            if !matches!(column.data_type(), DataType::Date64) {
                return Ok((field.clone(), column.clone()));
            }
            let dates = arrow::compute::cast(column, &DataType::Date32)
                .map_err(|e| format!("Failed to render date column: {}", e))?;
            Ok((retyped_field(field, dates.data_type()), dates))
        },
    )
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
    // Both stages below read the column's type, and neither looks through a
    // dictionary's keys; unpack once so they see the values themselves.
    let batches = batches
        .iter()
        .map(unpack_dictionaries)
        .collect::<Result<Vec<_>, String>>()?;
    let buf = batches_to_json_bytes(&batches)?;
    let mut rows = serde_json::Deserializer::from_slice(&buf)
        .into_iter::<Value>()
        .collect::<Result<Vec<Value>, _>>()
        .map_err(|e| format!("Failed to parse JSON results: {}", e))?;

    restore_non_finite_floats(&mut rows, &batches);

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
/// nothing. The filter bar's `quoteIdentifier` escapes the same way, and it
/// has to: the webview sends its `WHERE` fragment here to be planned, so a
/// column name the two spell differently resolves on one side and not the
/// other. `contracts/identifier-quoting-cases.json` is the shared list both
/// are tested against.
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

/// A sort's `ORDER BY`: the key column first, then the row's position in
/// the file (`position`, a `row_number() OVER ()` the query computes) in
/// the same direction.
///
/// The position is what makes paging over a sorted grid safe. Pages are
/// separate `ORDER BY ... LIMIT/OFFSET` queries, and DataFusion answers
/// each with a top-k heap sized to that page's `offset + limit`, whose
/// order among equal keys depends on the heap's shape — so two pages of
/// `ORDER BY category` alone could show the same row twice and another
/// never, whenever a run of equal values crossed the page boundary (a
/// category column with five values crosses it on every page). The
/// position is unique per row, so the order is total: ties come in file
/// order ascending and in reverse file order descending, rows identical in
/// every column included. The earlier design named every other sortable
/// column as the tie-breaker instead; on a file with hundreds of columns
/// DataFusion spent 100 ms and more planning that `ORDER BY` for 174 rows,
/// and rows that differed only in a nested column could still swap places.
///
/// The position is the row's index in the file, which is why the sorted
/// page can be read in two steps (`sorted_page_batches`): the query sorts
/// only the key and the position, and the parquet reader then fetches
/// those rows by index. It is only the file's order because every session
/// scans a single partition in file order (`get_or_create_session`) and
/// the `WHERE` clause is applied above the window rather than pushed into
/// the scan, which would skip rows before they are numbered.
///
/// The direction applies to both terms, so descending is exactly the
/// ascending sequence reversed, NULLs included (`ASC NULLS LAST`,
/// `DESC NULLS FIRST`, spelled out rather than left to the dialect).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SortOrder {
    terms: String,
    position: String,
}

impl SortOrder {
    /// The alias of the position column in the query: a name the file does
    /// not use, so it can never shadow a column the filter names.
    pub fn position(&self) -> &str {
        &self.position
    }
}

pub fn sort_order(sort: &SortSpec, columns: &[ColumnInfo]) -> Result<SortOrder, String> {
    let key = columns
        .iter()
        .find(|c| c.name == sort.column)
        .ok_or_else(|| format!("Cannot sort by {}: no such column", sort.column))?;
    if !is_sortable(key.kind) {
        return Err(format!("Cannot sort by {}: values of its type have no order", sort.column));
    }
    let (direction, position_direction) = match sort.direction {
        SortDirection::Asc => ("ASC NULLS LAST", "ASC"),
        SortDirection::Desc => ("DESC NULLS FIRST", "DESC"),
    };
    let mut position = String::from("__parqsee_pos");
    while columns.iter().any(|c| c.name == position) {
        position.push('_');
    }
    let terms = format!(
        "{} {}, {} {}",
        quote_identifier(&key.name),
        direction,
        quote_identifier(&position),
        position_direction
    );
    Ok(SortOrder { terms, position })
}

/// The one `SELECT * FROM t ...` shape the unsorted browse grid and the
/// filtered export share. Building it in one place keeps the exported rows
/// the same rows the grid paginates over.
pub fn build_page_query(filter: Option<&str>, offset: Option<usize>, limit: Option<usize>) -> String {
    let mut query = String::from("SELECT * FROM t");
    if let Some(f) = where_clause(filter) {
        query.push_str(&format!(" WHERE {}", f));
    }
    push_window(&mut query, offset, limit);
    query
}

/// `t` with each row's file position alongside its columns, the `WHERE`
/// applied above the numbering so a filter never changes a row's position
/// (see `SortOrder`). The filter cannot be pushed into the scan from here,
/// so a filtered sort scans every row group; it still reads only the key
/// and the filter's columns.
fn positioned_rows(filter: Option<&str>, order: &SortOrder) -> String {
    let mut from = format!(
        "FROM (SELECT *, row_number() OVER () AS {} FROM t)",
        quote_identifier(&order.position)
    );
    if let Some(f) = where_clause(filter) {
        from.push_str(&format!(" WHERE {}", f));
    }
    from
}

/// The positions of the rows of a sorted page, in the page's order: the
/// first step of `sorted_page_batches`, and all the sort DataFusion does.
pub fn build_position_query(
    filter: Option<&str>,
    order: &SortOrder,
    offset: Option<usize>,
    limit: Option<usize>,
) -> String {
    let mut query = format!(
        "SELECT {} {} ORDER BY {}",
        quote_identifier(&order.position),
        positioned_rows(filter, order),
        order.terms
    );
    push_window(&mut query, offset, limit);
    query
}

/// The rows of a sorted range with all their columns, in the order
/// `build_position_query` lists them: what a streamed sorted export
/// writes, so its rows come in the sequence the grid paginates over.
pub fn build_sorted_query(
    filter: Option<&str>,
    order: &SortOrder,
    offset: Option<usize>,
    limit: Option<usize>,
) -> String {
    let mut query = format!(
        "SELECT * EXCEPT ({}) {} ORDER BY {}",
        quote_identifier(&order.position),
        positioned_rows(filter, order),
        order.terms
    );
    push_window(&mut query, offset, limit);
    query
}

fn push_window(query: &mut String, offset: Option<usize>, limit: Option<usize>) {
    if let Some(limit) = limit {
        query.push_str(&format!(" LIMIT {}", limit));
    }
    if let Some(offset) = offset.filter(|o| *o > 0) {
        query.push_str(&format!(" OFFSET {}", offset));
    }
}

/// One page of rows. Without a filter or a sort the page comes straight
/// from the parquet reader with the range pushed down (see `range_reader`);
/// a `LIMIT/OFFSET` query would decode every row before the page, so the
/// last page of a large file took seconds in release and a minute in
/// debug. With a filter or a sort the page is the DataFusion query the
/// export shares, so what is exported is what the grid shows. Both paths
/// read row groups in file order, so the two paginate the same sequence.
/// An uncached sort is an `ORDER BY` over the whole file for that page;
/// counts and compact page batches share a bounded cache. See
/// `SortOrder` for what keeps its pages consistent and `sorted_page_batches`
/// for how far-half pages are read from the nearer end.
pub async fn read_data(
    cache: &ParquetCache,
    path: &str,
    offset: usize,
    limit: usize,
    filter: Option<String>,
    sort: Option<SortSpec>,
) -> Result<Vec<Value>, String> {
    cache.check_unchanged(path)?;
    if let Some(sort) = sort {
        let batches = sorted_page_batches(cache, path, offset, limit, filter, sort, ResultCachePolicy::Populate)
            .await.map_err(|e| {
                if is_memory_exhausted(&e) {
                    "This page is too deep into the sort for a file this large: sorting it \
                     needs more memory than the app allows itself. Narrow the rows with a \
                     filter, page from the other end, or sort in the SQL view.".to_string()
                } else {
                    e
                }
            })?;
        return batches_to_rows(&batches);
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
            let query = build_page_query(filter.as_deref(), Some(offset), Some(limit));
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
    count_data_with_policy(cache, path, filter, ResultCachePolicy::Populate).await
}

async fn count_data_with_policy(
    cache: &ParquetCache,
    path: &str,
    filter: Option<String>,
    policy: ResultCachePolicy,
) -> Result<usize, String> {
    cache.check_unchanged(path)?;
    let query = match where_clause(filter.as_deref()) {
        Some(f) => format!("SELECT COUNT(*) FROM t WHERE {}", f),
        None => "SELECT COUNT(*) FROM t".to_string(),
    };

    let batches = execute_browse_query(cache, path, &query, policy).await?;
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

/// The protocol every cached browse read follows: open the session, take
/// the file's version, answer from the cache if it holds this query's
/// rows, and otherwise compute them — then check the version again
/// before storing. That second check is the load-bearing step: the file
/// can be rewritten while the rows are being read, and rows from the old
/// one stored under the new version would be served as the new file's
/// until something else evicted them. `compute` returns the rows and
/// whether the plan that made them may be reused (`reusable_plan`).
///
/// Bounded LRU of Arrow batches. Session identity prevents an in-flight read
/// from repopulating the cache after Refresh/close evicts that session.
async fn cached_or_compute<F, Fut>(
    cache: &ParquetCache,
    path: &str,
    query: &str,
    policy: ResultCachePolicy,
    compute: F,
) -> Result<Vec<RecordBatch>, String>
where
    F: FnOnce(datafusion::execution::context::SessionContext) -> Fut,
    Fut: std::future::Future<Output = Result<(Vec<RecordBatch>, bool), String>>,
{
    let ctx = cache.get_or_create_session(path).await?;
    let version = FileVersion::read(path)?;
    if let Some(batches) = cached_result(cache, path, &ctx, &version, query)? {
        return Ok(batches);
    }
    let (batches, reusable) = compute(ctx.clone()).await?;
    version.check(path)?;
    store_result(cache, path, &ctx, version, query, batches, reusable, policy)
}

async fn execute_browse_query(
    cache: &ParquetCache,
    path: &str,
    query: &str,
    policy: ResultCachePolicy,
) -> Result<Vec<RecordBatch>, String> {
    cached_or_compute(cache, path, query, policy, |ctx| async move {
        run_browse_query(&ctx, query, false).await
    })
    .await
}

/// A sorted page's rows, keyed in the result cache by its position query
/// (`build_position_query`): the query sorts the key and the row position
/// only, and the rows come out of the parquet reader by position
/// (`rows_at_positions`), so a sort on a file with hundreds of columns
/// plans and reads a two-column query instead of a wide one. A top-k
/// that outgrows the session's memory falls back to the spillable full
/// sort — `prefer_full_page_sort` picks it up front for deep pages, but
/// the depth at which a top-k of a huge file exhausts the pool is not a
/// fixed fraction of the file, and a page that fails only because it is
/// shallower than the crossover is not one the user can reason about.
async fn sorted_rows(
    cache: &ParquetCache,
    path: &str,
    query: &str,
    policy: ResultCachePolicy,
    full_sort: bool,
) -> Result<Vec<RecordBatch>, String> {
    cached_or_compute(cache, path, query, policy, |ctx| async move {
        let (positions, reusable) = match run_browse_query(&ctx, query, full_sort).await {
            Err(e) if !full_sort && is_memory_exhausted(&e) => {
                run_browse_query(&ctx, query, true).await?
            }
            other => other?,
        };
        let positions = positions_from_batches(&positions)?;
        // Decoding is CPU-bound; keep it off the async workers like an unfiltered page.
        let owned = path.to_string();
        let batch = tokio::task::spawn_blocking(move || rows_at_positions(&owned, &positions))
            .await
            .map_err(|e| format!("Failed to read parquet file {}: {}", path, e))??;
        Ok((vec![batch], reusable))
    })
    .await
}

fn cached_result(
    cache: &ParquetCache,
    path: &str,
    ctx: &datafusion::execution::context::SessionContext,
    version: &FileVersion,
    query: &str,
) -> Result<Option<Vec<RecordBatch>>, String> {
    let session_id = ctx.session_id();
    let hit = {
        let mut results = cache.results.lock().map_err(|e| e.to_string())?;
        results.retain(|r| r.path != path || r.version == *version);
        if let Some(index) = results.iter().position(|r| {
            r.path == path && r.session_id == session_id && r.version == *version && r.query == query
        }) {
            let result = results.remove(index).expect("cache entry exists");
            let batches = result.batches.clone();
            results.push_back(result);
            Some(batches)
        } else {
            None
        }
    };
    if hit.is_some() {
        version.check(path)?;
    }
    Ok(hit)
}

/// Plan, check and run one browse query; `full_sort` swaps the page's
/// top-k for an ordinary sort (`full_sort_page_plan`). The flag says
/// whether the result may be cached (`reusable_plan`).
async fn run_browse_query(
    ctx: &datafusion::execution::context::SessionContext,
    query: &str,
    full_sort: bool,
) -> Result<(Vec<RecordBatch>, bool), String> {
    let plan = plan_query_checked(ctx, query).await?;
    let reusable = reusable_plan(&plan)?;
    let df = ctx.execute_logical_plan(plan).await
        .map_err(|e| format!("SQL execution failed: {}", e))?;
    let batches = if full_sort {
        let physical = df.create_physical_plan().await
            .map_err(|e| format!("Failed to plan sorted page: {}", e))?;
        datafusion::physical_plan::collect(full_sort_page_plan(physical), ctx.task_ctx()).await
    } else {
        df.collect().await
    }.map_err(|e| format!("Failed to collect results: {}", e))?;
    Ok((batches, reusable))
}

/// Whether a result earns a place in the shared cache. It has to be one
/// the grid can ask for again (`reusable`: no clock, no randomness), a
/// page rather than a bulk range, and small enough that a single entry
/// cannot evict the whole cache to make room for itself — which is also
/// what lets `evict_for` terminate.
fn worth_caching(policy: ResultCachePolicy, reusable: bool, rows: usize, bytes: usize) -> bool {
    policy == ResultCachePolicy::Populate
        && reusable
        && rows <= RESULT_CACHE_MAX_ROWS
        && bytes <= RESULT_CACHE_BYTES
}

/// Drop the oldest results until one of `bytes` fits within both caps.
/// Insertion order is age, so the front is the oldest. The loop ends
/// because `bytes <= RESULT_CACHE_BYTES` is checked before it is reached
/// (`worth_caching`): emptying the queue is therefore always enough.
fn evict_for(results: &mut VecDeque<CachedResult>, bytes: usize) {
    let mut used: usize = results.iter().map(|r| r.bytes).sum();
    while results.len() >= RESULT_CACHE_ENTRIES || used + bytes > RESULT_CACHE_BYTES {
        match results.pop_front() {
            Some(old) => used -= old.bytes,
            None => return,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn store_result(
    cache: &ParquetCache,
    path: &str,
    ctx: &datafusion::execution::context::SessionContext,
    version: FileVersion,
    query: &str,
    mut batches: Vec<RecordBatch>,
    reusable: bool,
    policy: ResultCachePolicy,
) -> Result<Vec<RecordBatch>, String> {
    let session_id = ctx.session_id();
    let rows = batches.iter().map(RecordBatch::num_rows).sum::<usize>();
    // LIMIT can return a slice backed by the entire top-k output. Copy only
    // page-sized results; very large ranges remain uncached.
    if reusable && rows <= RESULT_CACHE_MAX_ROWS {
        batches = batches.iter().map(compact_batch).collect::<Result<_, _>>()?;
    }
    // Include keys as well as arrays; do not retain an unbounded filter string.
    let bytes = batches.iter().map(RecordBatch::get_array_memory_size).sum::<usize>()
        + path.len() + session_id.len() + query.len();
    if worth_caching(policy, reusable, rows, bytes) {
        let sessions = cache.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.get(path).is_some_and(|ctx| ctx.session_id() == session_id) {
            let mut results = cache.results.lock().map_err(|e| e.to_string())?;
            results.retain(|r| !(r.path == path && r.session_id == session_id && r.query == query));
            evict_for(&mut results, bytes);
            results.push_back(CachedResult {
                path: path.into(), session_id, version, query: query.into(), batches: batches.clone(), bytes,
            });
        }
    }
    Ok(batches)
}

/// The single column of a position query, zero-based: `row_number()` is
/// one-based and unsigned.
fn positions_from_batches(batches: &[RecordBatch]) -> Result<Vec<usize>, String> {
    use arrow::array::UInt64Array;
    let mut positions = Vec::with_capacity(batches.iter().map(RecordBatch::num_rows).sum());
    for batch in batches {
        let column = batch.column(0).as_any().downcast_ref::<UInt64Array>()
            .ok_or_else(|| "Failed to downcast row positions".to_string())?;
        for i in 0..column.len() {
            let position = column.value(i);
            positions.push(usize::try_from(position.checked_sub(1).ok_or("Invalid row position 0")?)
                .map_err(|_| format!("Invalid row position {position}"))?);
        }
    }
    Ok(positions)
}

/// The rows at `positions` (zero-based, in any order), as one batch in the
/// order given. The reader is handed a row selection, so it decodes the
/// pages holding those rows and skips whole row groups none of them fall
/// in: 100 rows spread over a 58M-row file came back in 0.4 s in release.
/// A position past the end means the file changed since the query ran.
fn rows_at_positions(path: &str, positions: &[usize]) -> Result<RecordBatch, String> {
    use arrow::array::UInt64Array;
    use parquet::arrow::arrow_reader::{RowSelection, RowSelector};

    let builder = open_reader_builder(path)?;
    let total = usize::try_from(builder.metadata().file_metadata().num_rows()).unwrap_or(0);
    if positions.iter().any(|&p| p >= total) {
        return Err("The file changed while reading it. Refresh and try again.".into());
    }
    let schema = builder.schema().clone();
    if positions.is_empty() {
        return Ok(RecordBatch::new_empty(schema));
    }
    let mut sorted = positions.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut selectors = Vec::with_capacity(sorted.len() * 2 + 1);
    let mut cursor = 0;
    for &position in &sorted {
        if position > cursor {
            selectors.push(RowSelector::skip(position - cursor));
        }
        selectors.push(RowSelector::select(1));
        cursor = position + 1;
    }
    if cursor < total {
        selectors.push(RowSelector::skip(total - cursor));
    }
    let reader = builder
        .with_batch_size(sorted.len())
        .with_row_selection(RowSelection::from(selectors))
        .build()
        .map_err(|e| format!("Failed to read parquet file {}: {}", path, e))?;
    let batches = reader
        .map(|b| b.map_err(|e| format!("Failed to read parquet file {}: {}", path, e)))
        .collect::<Result<Vec<_>, _>>()?;
    let rows = arrow::compute::concat_batches(&schema, &batches).map_err(|e| e.to_string())?;
    if rows.num_rows() != sorted.len() {
        return Err("The file changed while reading it. Refresh and try again.".into());
    }
    // The reader returns file order; put the rows back into the page's order.
    let indices = UInt64Array::from_iter_values(positions.iter().map(|p| {
        sorted.binary_search(p).expect("every position was selected") as u64
    }));
    let columns = rows.columns().iter()
        .map(|column| arrow::compute::take(column.as_ref(), &indices, None))
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    RecordBatch::try_new(schema, columns).map_err(|e| e.to_string())
}

/// Top-K is excellent near either end, but maintaining a heap for a large
/// fraction of the file costs more than a batch sort/merge. Keep small files
/// and shallow windows on Top-K. In release probes over 1M rows, a 25%-deep
/// page improved for category, random, ordered numeric and text keys; at 1%
/// depth an ordinary sort regressed ordered keys. This is a conservative
/// crossover, not a universal optimizer cost model.
fn prefer_full_page_sort(offset: usize, total: usize) -> bool {
    offset >= 16_384 && offset >= total / 4
}

/// Remove only the outer page sort's Top-K, *after* physical optimization
/// (otherwise DataFusion pushes fetch back into it). Keep GlobalLimit and
/// every ORDER BY key intact; the projection a position query puts over
/// the limit (`build_position_query`) is looked through. Nested sorts in
/// user filters are untouched, and a plan of any other shape is used as it
/// is, so a future optimizer producing a different shape safely retains
/// its plan.
fn full_sort_page_plan(
    plan: Arc<dyn datafusion::physical_plan::ExecutionPlan>,
) -> Arc<dyn datafusion::physical_plan::ExecutionPlan> {
    use datafusion::physical_plan::{limit::GlobalLimitExec, projection::ProjectionExec, sorts::sort::SortExec};
    fn rewrite(
        plan: &Arc<dyn datafusion::physical_plan::ExecutionPlan>,
    ) -> Option<Arc<dyn datafusion::physical_plan::ExecutionPlan>> {
        if let Some(projection) = plan.downcast_ref::<ProjectionExec>() {
            let input = rewrite(projection.input())?;
            return Arc::clone(plan).with_new_children(vec![input]).ok();
        }
        let limit = plan.downcast_ref::<GlobalLimitExec>()?;
        let sort = limit.input().downcast_ref::<SortExec>()?;
        if limit.skip() == 0 || sort.preserve_partitioning()
            || sort.fetch() != limit.fetch().map(|n| limit.skip().saturating_add(n))
        {
            return None;
        }
        // The scan's old Top-K dynamic predicate starts at true. No Top-K now
        // updates it, so it cannot discard rows needed by the ordinary sort.
        let sort = Arc::new(SortExec::new(sort.expr().clone(), Arc::clone(sort.input())));
        Some(Arc::new(GlobalLimitExec::new(sort, limit.skip(), limit.fetch())))
    }
    rewrite(&plan).unwrap_or(plan)
}

fn compact_batch(batch: &RecordBatch) -> Result<RecordBatch, String> {
    use arrow::array::{ArrayRef, BinaryViewArray, StringViewArray, UInt64Array};
    let indices = UInt64Array::from_iter_values(0..batch.num_rows() as u64);
    let columns = batch.columns().iter().map(|column| {
        let taken = arrow::compute::take(column.as_ref(), &indices, None)?;
        // take() copies view descriptors but retains the referenced blocks.
        let compact: ArrayRef = if let Some(strings) = taken.as_any().downcast_ref::<StringViewArray>() {
            Arc::new(strings.gc())
        } else if let Some(binary) = taken.as_any().downcast_ref::<BinaryViewArray>() {
            Arc::new(binary.gc())
        } else {
            taken
        };
        Ok(compact)
    }).collect::<Result<Vec<_>, arrow::error::ArrowError>>().map_err(|e| e.to_string())?;
    RecordBatch::try_new(batch.schema(), columns).map_err(|e| e.to_string())
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
/// small heap. For Top-K the worst page is the middle one, at half the
/// file; `prefer_full_page_sort` switches deep windows to an ordinary sort.
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
/// is in is shared with the frontend's count through the result cache.
/// After mirroring, deep windows use an ordinary sort instead of Top-K.
/// The sort itself is over the key and the row position only
/// (`build_position_query`); the page's rows are then read by position
/// (`sorted_rows`), so the width of the file never enters the sort.
pub(crate) async fn sorted_page_batches(
    cache: &ParquetCache,
    path: &str,
    offset: usize,
    limit: usize,
    filter: Option<String>,
    sort: SortSpec,
    policy: ResultCachePolicy,
) -> Result<Vec<RecordBatch>, String> {
    let metadata = cache.get_or_create_metadata(path).await?;
    let version = FileVersion::read(path)?;
    // Even without a filter, cached UI metadata may describe an older file.
    // COUNT(*) is answered from Parquet metadata and versioned like pages.
    let total = count_data_with_policy(cache, path, filter.clone(), policy).await?;
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
    let order = sort_order(&sort, &metadata.columns)?;
    let query = build_position_query(filter.as_deref(), &order, Some(offset), Some(limit));
    let batches = sorted_rows(cache, path, &query, policy, prefer_full_page_sort(offset, total)).await?;
    // A key per query is insufficient if the file changes between the count
    // and page queries: refuse a window computed for a different version.
    version.check(path)?;
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
    let (batches, schema, _, _) = execute_sql_limited(cache, file_path, query, None).await?;
    Ok((batches, schema))
}

/// Run `query`, keeping at most `max_rows` rows of the result. The limit is
/// pushed into the plan, so a `SELECT *` over a large file does not
/// materialize every row before being cut down. The returned flag tells
/// whether rows were dropped.
///
/// The qualifier of each column comes back beside the Arrow schema, which
/// has none: DataFusion tracks a column's table alongside its name, and
/// lets `a.id` and `b.id` both reach the Arrow schema as `id`. The
/// qualifier is the only thing that tells the two apart, so a caller that
/// has to name the columns needs it (`commands::query::unique_column_names`).
///
/// Unlike the browse paths, this does not refuse a file that changed since
/// it was opened (`ParquetCache::check_unchanged`). The grid answers such a
/// file with a message because the page it would draw contradicts the row
/// count and the header beside it; a query states its own shape in its
/// `SELECT`, has no Refresh of its own to offer, and querying a file that
/// has just been rewritten is a reasonable thing to want. What it sees is
/// still the session's registered schema, so a rewrite that changed the
/// columns answers for the old ones until the tab is refreshed.
pub async fn execute_sql_limited(
    cache: &ParquetCache,
    file_path: &str,
    query: &str,
    max_rows: Option<usize>,
) -> Result<(Vec<RecordBatch>, arrow::datatypes::SchemaRef, Vec<Option<String>>, bool), String> {
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
    let qualifiers: Vec<Option<String>> = df
        .schema()
        .iter()
        .map(|(qualifier, _)| qualifier.map(|q| q.table().to_string()))
        .collect();

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

    Ok((batches, schema, qualifiers, truncated))
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
        Array, ArrayRef, Decimal128Array, Decimal128Builder, DictionaryArray, FixedSizeListBuilder,
        Int32Array, Int32Builder, Int64Array, ListBuilder, MapBuilder, StringArray, StringBuilder,
        StructArray,
    };
    use arrow::datatypes::{DataType, Field, Fields, Int32Type, Schema};
    use arrow::record_batch::RecordBatch;
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn temp_path(name: &str) -> PathBuf {
        test_support::temp_path("parquet", name)
    }

    #[derive(serde::Deserialize)]
    struct SortableKindCase {
        kind: ColumnKind,
        sortable: bool,
    }

    /// Every `ColumnKind`, listed in a `match` so that adding a variant
    /// stops this test compiling. `is_sortable` uses `matches!` and would
    /// silently call a new kind sortable, and the header's
    /// `isSortableColumn` would silently agree — the contract is only worth
    /// anything if a new kind cannot reach either side without being named
    /// in it.
    fn every_kind() -> Vec<ColumnKind> {
        let all = vec![
            ColumnKind::Boolean, ColumnKind::Integer, ColumnKind::Float, ColumnKind::Decimal,
            ColumnKind::Text, ColumnKind::Temporal, ColumnKind::Binary, ColumnKind::Nested,
            ColumnKind::Other,
        ];
        for kind in &all {
            match kind {
                ColumnKind::Boolean | ColumnKind::Integer | ColumnKind::Float
                | ColumnKind::Decimal | ColumnKind::Text | ColumnKind::Temporal
                | ColumnKind::Binary | ColumnKind::Nested | ColumnKind::Other => {}
            }
        }
        all
    }

    #[test]
    fn sortable_kinds_follow_the_contract_the_header_is_held_to() {
        let cases: Vec<SortableKindCase> = serde_json::from_str(include_str!(
            "../../../contracts/sortable-kinds-cases.json"
        ))
        .expect("the shared sortable-kinds contract must be valid JSON");
        for case in &cases {
            assert_eq!(super::is_sortable(case.kind), case.sortable, "{:?}", case.kind);
        }
        for kind in every_kind() {
            assert!(cases.iter().any(|c| c.kind == kind), "the contract does not name {kind:?}");
        }
    }

    #[derive(serde::Deserialize)]
    struct IdentifierQuotingCase {
        name: String,
        quoted: String,
    }

    #[test]
    fn quoting_follows_the_contract_the_filter_bar_is_held_to() {
        let cases: Vec<IdentifierQuotingCase> = serde_json::from_str(include_str!(
            "../../../contracts/identifier-quoting-cases.json"
        ))
        .expect("the shared identifier-quoting contract must be valid JSON");
        for case in cases {
            assert_eq!(super::quote_identifier(&case.name), case.quoted, "{}", case.name);
        }
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
        assert!(rows[1].get("small").is_none_or(|v| v.is_null()));
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

    /// `[1.5, NaN, +inf, NULL, 2.5]` as a `Dictionary(Int32, Float64)`, the
    /// shape pandas' categorical and pyarrow's `dictionary_encode()` write.
    fn write_dictionary_float_fixture(name: &str) -> PathBuf {
        let values = Arc::new(arrow::array::Float64Array::from(vec![
            1.5,
            f64::NAN,
            f64::INFINITY,
            2.5,
        ])) as ArrayRef;
        let keys = Int32Array::from(vec![Some(0), Some(1), Some(2), None, Some(3)]);
        let dictionary = DictionaryArray::<Int32Type>::try_new(keys, values).unwrap();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "dfloat",
            dictionary.data_type().clone(),
            true,
        )]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(dictionary) as ArrayRef]).unwrap();
        let path = temp_path(&format!("{name}.parquet"));
        write_parquet(&path, &batch, None);
        path
    }

    #[tokio::test]
    async fn dictionary_encoded_floats_keep_nan_and_infinity() {
        let path = write_dictionary_float_fixture("dictionary_float");
        let cache = ParquetCache::new();

        // The dictionary column is a column like any other to the schema read.
        let metadata = cache
            .get_or_create_metadata(&path.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(metadata.num_rows, 5);
        assert_eq!(metadata.columns[0].name, "dfloat");

        // The three read paths: the parquet reader, DataFusion under a
        // filter, and a sorted page.
        let sort = SortSpec {
            column: "dfloat".into(),
            direction: SortDirection::Asc,
        };
        for (label, filter, sort) in [
            ("unfiltered", None, None),
            ("filtered", Some("1 = 1".to_string()), None),
            ("sorted", None, Some(sort)),
        ] {
            let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 5, filter, sort)
                .await
                .unwrap();
            // The sorted page orders by the float, which puts NULL last and
            // NaN above the infinities; find each row by its value instead of
            // pinning an order this test is not about.
            let spellings: Vec<Option<&serde_json::Value>> =
                rows.iter().map(|r| r.get("dfloat")).collect();
            assert!(
                spellings.contains(&Some(&serde_json::json!("NaN"))),
                "{label}: NaN came back as {spellings:?}"
            );
            assert!(
                spellings.contains(&Some(&serde_json::json!("Infinity"))),
                "{label}: Infinity came back as {spellings:?}"
            );
            assert!(
                spellings.contains(&Some(&serde_json::json!(1.5))),
                "{label}: a finite value stopped being a number: {spellings:?}"
            );
            assert!(
                spellings.contains(&Some(&serde_json::json!(2.5))),
                "{label}: a finite value stopped being a number: {spellings:?}"
            );
            // NULL is the one row with no value at all.
            assert_eq!(
                spellings.iter().filter(|v| v.is_none()).count(),
                1,
                "{label}: {spellings:?}"
            );
        }
    }

    #[tokio::test]
    async fn dictionary_encoded_big_integers_stay_exact() {
        let values = Arc::new(Int64Array::from(vec![9_007_199_254_740_993i64])) as ArrayRef;
        let keys = Int32Array::from(vec![Some(0)]);
        let dictionary = DictionaryArray::<Int32Type>::try_new(keys, values).unwrap();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "id",
            dictionary.data_type().clone(),
            true,
        )]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(dictionary) as ArrayRef]).unwrap();
        let path = temp_path("dictionary_big_int.parquet");
        write_parquet(&path, &batch, None);

        let rows = super::read_data(&ParquetCache::new(), &path.to_string_lossy(), 0, 1, None, None)
            .await
            .unwrap();
        assert_eq!(rows[0]["id"], "9007199254740993");
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

    /// A file whose sort key is far too wide to keep `offset + limit` rows
    /// of in a small pool: `n` rows of a 1 KB string, written in descending
    /// id order so the sorted order is the reverse of the file's and a
    /// position can be checked against the id it belongs to.
    fn wide_text_file(n: i64, name: &str) -> PathBuf {
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("id", DataType::Int64, false),
                Field::new("text", DataType::Utf8, false),
            ])),
            vec![
                Arc::new(Int64Array::from((0..n).rev().collect::<Vec<_>>())) as ArrayRef,
                Arc::new(StringArray::from((0..n).rev().map(|i| format!("{i:08}{}", "x".repeat(1024))).collect::<Vec<_>>())),
            ],
        ).unwrap();
        let path = temp_path(name);
        write_parquet(&path, &batch, None);
        path
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

    /// A count and the sorted window drawn beside it must always come from
    /// the same file: the count cached for the old one over rows read from
    /// the new one is a footer that contradicts the grid. The overwrite is
    /// refused until the tab is refreshed, and after the refresh the two
    /// agree again — whether the file grew or shrank.
    #[tokio::test]
    async fn overwritten_files_do_not_mix_cached_counts_and_fresh_sort_windows() {
        let path = temp_path("sort_overwrite.parquet");
        let write = |n| {
            let batch = RecordBatch::try_from_iter(vec![("id", Arc::new(Int64Array::from_iter_values(0..n)) as ArrayRef)]).unwrap();
            write_parquet(&path, &batch, None);
        };
        write(10);
        let file = path.to_string_lossy();
        let cache = ParquetCache::new();
        cache.get_or_create_metadata(&file).await.unwrap();
        assert_eq!(super::count_data(&cache, &file, Some("id >= 0".into())).await.unwrap(), 10);
        for rows_written in [20, 8] {
            write(rows_written);
            let err = super::count_data(&cache, &file, Some("id >= 0".into())).await.unwrap_err();
            assert!(err.contains("Refresh"), "{err}");
            cache.evict(&file).await.unwrap();
            cache.get_or_create_metadata(&file).await.unwrap();
            for filter in [Some("id >= 0".into()), None] {
                let rows = super::read_data(&cache, &file, 6, 2, filter.clone(),
                    Some(SortSpec { column: "id".into(), direction: SortDirection::Asc })).await.unwrap();
                assert_eq!(rows.iter().map(|r| r["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![6, 7]);
                assert_eq!(super::count_data(&cache, &file, filter).await.unwrap(), rows_written as usize);
            }
        }
    }

    #[tokio::test]
    async fn counts_are_reused_and_refresh_invalidates_them() {
        let path = temp_path("cached_count.parquet");
        write_small(&path);
        let file = path.to_string_lossy();
        let cache = ParquetCache::new();
        let filter = Some("id > 1".into());
        assert_eq!(super::count_data(&cache, &file, filter.clone()).await.unwrap(), 2);
        let original = cache.results.lock().unwrap().back().unwrap().batches[0].column(0).clone();
        assert_eq!(super::count_data(&cache, &file, filter.clone()).await.unwrap(), 2);
        let reused = cache.results.lock().unwrap().back().unwrap().batches[0].column(0).clone();
        assert!(Arc::ptr_eq(&original, &reused), "reuse the same Arrow allocation");
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
            super::execute_browse_query(&cache, &file, query, super::ResultCachePolicy::Populate).await.unwrap();
            assert!(!cache.results.lock().unwrap().iter().any(|r| r.query == query));
        }
    }

    fn cached_of(bytes: usize) -> super::CachedResult {
        super::CachedResult {
            path: "p".into(),
            session_id: "s".into(),
            version: super::FileVersion { size: 0, modified: std::time::UNIX_EPOCH },
            query: "q".into(),
            batches: Vec::new(),
            bytes,
        }
    }

    #[test]
    fn only_a_reusable_page_small_enough_to_share_the_cache_is_kept() {
        use super::ResultCachePolicy::{Populate, ReuseOnly};
        assert!(super::worth_caching(Populate, true, 100, 1024));
        // A query whose answer can change on its own is never reused.
        assert!(!super::worth_caching(Populate, false, 100, 1024));
        // A read that is only allowed to reuse what is there adds nothing.
        assert!(!super::worth_caching(ReuseOnly, true, 100, 1024));
        // A bulk range would push out the pages the grid is paging through.
        assert!(!super::worth_caching(Populate, true, super::RESULT_CACHE_MAX_ROWS + 1, 1024));
        // An entry that cannot fit even in an empty cache is refused here,
        // which is what stops `evict_for` emptying the queue for nothing.
        assert!(super::worth_caching(Populate, true, 1, super::RESULT_CACHE_BYTES));
        assert!(!super::worth_caching(Populate, true, 1, super::RESULT_CACHE_BYTES + 1));
    }

    #[test]
    fn making_room_drops_the_oldest_and_stops_as_soon_as_the_entry_fits() {
        let mut results: std::collections::VecDeque<super::CachedResult> =
            (0..super::RESULT_CACHE_ENTRIES).map(|_| cached_of(1)).collect();
        super::evict_for(&mut results, 1);
        // One short of the cap, so the entry about to be pushed fits it.
        assert_eq!(results.len(), super::RESULT_CACHE_ENTRIES - 1);

        // The byte cap can bite long before the entry cap does.
        let half = super::RESULT_CACHE_BYTES / 2;
        let mut results: std::collections::VecDeque<super::CachedResult> =
            [half, half].into_iter().map(cached_of).collect();
        super::evict_for(&mut results, half);
        assert_eq!(results.len(), 1);

        // Nothing is dropped when there is already room.
        let mut results: std::collections::VecDeque<super::CachedResult> = [1, 2].into_iter().map(cached_of).collect();
        super::evict_for(&mut results, 1);
        assert_eq!(results.len(), 2);

        // An entry the size of the whole cache empties it and stops there.
        let mut results: std::collections::VecDeque<super::CachedResult> = [1, 2].into_iter().map(cached_of).collect();
        super::evict_for(&mut results, super::RESULT_CACHE_BYTES);
        assert!(results.is_empty());
    }

    #[test]
    fn cached_pages_do_not_retain_the_topk_buffers() {
        let strings = arrow::array::StringViewArray::from_iter_values(
            (0..20_000).map(|i| format!("row {i:08} with a long string payload")),
        );
        let batch = RecordBatch::try_from_iter(vec![
            ("id", Arc::new(Int64Array::from_iter_values(0..20_000)) as ArrayRef),
            ("text", Arc::new(strings) as ArrayRef),
        ]).unwrap().slice(10_000, 100);
        let compact = super::compact_batch(&batch).unwrap();
        assert_eq!(batch, compact);
        assert!(compact.get_array_memory_size() < 20_000);
        assert!(batch.get_array_memory_size() > 500_000);
    }

    #[tokio::test]
    async fn sorted_pages_are_reused_with_distinct_windows_and_orders() {
        let path = temp_path("cached_pages.parquet");
        write_small(&path);
        let file = path.to_string_lossy();
        let cache = ParquetCache::new();
        for (offset, direction, filter, id) in [
            (0, SortDirection::Asc, None, 1),
            (1, SortDirection::Asc, None, 2),
            (0, SortDirection::Desc, None, 3),
            (0, SortDirection::Asc, Some("id > 1".to_string()), 2),
        ] {
            let sort = Some(SortSpec { column: "id".into(), direction });
            let first = super::read_data(&cache, &file, offset, 1, filter.clone(), sort.clone()).await.unwrap();
            assert_eq!(first[0]["id"], id);
            let original = cache.results.lock().unwrap().back().unwrap().batches[0].column(0).clone();
            let hit = super::read_data(&cache, &file, offset, 1, filter, sort).await.unwrap();
            let reused = cache.results.lock().unwrap().back().unwrap().batches[0].column(0).clone();
            assert!(Arc::ptr_eq(&original, &reused));
            assert_eq!(hit, first);
        }
        cache.evict(&file).await.unwrap();
        assert!(cache.results.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn changed_or_missing_files_do_not_return_a_cached_page() {
        let path = temp_path("changed_page.parquet");
        write_small(&path);
        let file = path.to_string_lossy();
        let cache = ParquetCache::new();
        let sort = Some(SortSpec { column: "id".into(), direction: SortDirection::Asc });
        let rows = super::read_data(&cache, &file, 0, 1, None, sort.clone()).await.unwrap();
        assert_eq!(rows[0]["id"], 1);
        let before = super::FileVersion::read(&file).unwrap();
        let batch = RecordBatch::try_from_iter(vec![("id", Arc::new(Int64Array::from(vec![4, 5, 6])) as ArrayRef)]).unwrap();
        write_parquet(&path, &batch, None);
        // Force a distinct timestamp even on a filesystem with coarse times.
        std::fs::File::options().write(true).open(&path).unwrap().set_times(
            std::fs::FileTimes::new().set_modified(before.modified + Duration::from_secs(2)),
        ).unwrap();
        assert_eq!(before.size, super::FileVersion::read(&file).unwrap().size,
            "the timestamp must invalidate even a same-size overwrite");
        assert!(before.check(&file).unwrap_err().contains("file changed"));
        // The page cached for the old file is not served for the new one:
        // the read is refused outright, and a refresh is what brings the
        // new rows back.
        let err = super::read_data(&cache, &file, 0, 1, None, sort.clone()).await.unwrap_err();
        assert!(err.contains("Refresh"), "{err}");
        cache.evict(&file).await.unwrap();
        let rows = super::read_data(&cache, &file, 0, 1, None, sort.clone()).await.unwrap();
        assert_eq!(rows[0]["id"], 4);
        std::fs::remove_file(&path).unwrap();
        assert!(super::read_data(&cache, &file, 0, 1, None, sort).await.is_err());
    }

    fn write_numbered(path: &Path, rows: i64) {
        let batch = RecordBatch::try_from_iter(vec![(
            "id",
            Arc::new(Int64Array::from_iter_values(0..rows)) as ArrayRef,
        )])
        .unwrap();
        write_parquet(path, &batch, None);
    }

    /// What an unrelated program writing over the open file leaves behind:
    /// fewer rows and another schema entirely.
    fn five_rows_two_columns() -> RecordBatch {
        RecordBatch::try_from_iter(vec![
            ("id", Arc::new(Int64Array::from_iter_values(100..105)) as ArrayRef),
            (
                "label",
                Arc::new(StringArray::from(vec!["a", "b", "c", "d", "e"])) as ArrayRef,
            ),
        ])
        .unwrap()
    }

    /// An unfiltered page comes straight out of the parquet reader with the
    /// offset pushed down, so a rewritten file would be cut to the old row
    /// count without anything failing: page 3 of the old file reads as no
    /// rows at all under the footer of the new one.
    #[tokio::test]
    async fn an_unfiltered_page_after_the_file_was_rewritten_is_refused_until_refresh() {
        let path = temp_path("rewritten_unfiltered.parquet");
        write_numbered(&path, 20);
        let file = path.to_string_lossy().to_string();
        let cache = ParquetCache::new();
        cache.get_or_create_metadata(&file).await.unwrap();
        let rows = super::read_data(&cache, &file, 0, 5, None, None).await.unwrap();
        assert_eq!(rows[0]["id"], 0);

        test_support::rewrite_parquet(&path, &five_rows_two_columns());

        let err = super::read_data(&cache, &file, 10, 5, None, None).await.unwrap_err();
        assert!(err.contains("Refresh"), "{err}");

        cache.evict(&file).await.unwrap();
        cache.get_or_create_metadata(&file).await.unwrap();
        let rows = super::read_data(&cache, &file, 0, 5, None, None).await.unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0]["id"], 100);
        assert_eq!(rows[0]["label"], "a");
    }

    /// A filtered page goes through the session instead, whose schema is the
    /// one the file had when it was registered: the schema adapter would
    /// cast or NULL-fill the new file's columns into it and answer.
    #[tokio::test]
    async fn a_filtered_page_after_the_file_was_rewritten_is_refused() {
        let path = temp_path("rewritten_filtered.parquet");
        write_numbered(&path, 20);
        let file = path.to_string_lossy().to_string();
        let cache = ParquetCache::new();
        cache.get_or_create_metadata(&file).await.unwrap();
        let filter = Some("id >= 0".to_string());
        let rows = super::read_data(&cache, &file, 0, 5, filter.clone(), None).await.unwrap();
        assert_eq!(rows.len(), 5);

        test_support::rewrite_parquet(&path, &five_rows_two_columns());

        let err = super::read_data(&cache, &file, 0, 5, filter.clone(), None).await.unwrap_err();
        assert!(err.contains("Refresh"), "{err}");

        cache.evict(&file).await.unwrap();
        cache.get_or_create_metadata(&file).await.unwrap();
        let rows = super::read_data(&cache, &file, 0, 5, filter, None).await.unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0]["id"], 100);
    }

    /// The count the footer says the grid is paging over.
    #[tokio::test]
    async fn a_count_after_the_file_was_rewritten_is_refused() {
        let path = temp_path("rewritten_count.parquet");
        write_numbered(&path, 20);
        let file = path.to_string_lossy().to_string();
        let cache = ParquetCache::new();
        cache.get_or_create_metadata(&file).await.unwrap();
        assert_eq!(super::count_data(&cache, &file, None).await.unwrap(), 20);

        test_support::rewrite_parquet(&path, &five_rows_two_columns());

        let err = super::count_data(&cache, &file, None).await.unwrap_err();
        assert!(err.contains("Refresh"), "{err}");

        cache.evict(&file).await.unwrap();
        cache.get_or_create_metadata(&file).await.unwrap();
        assert_eq!(super::count_data(&cache, &file, None).await.unwrap(), 5);
    }

    #[tokio::test]
    async fn export_reads_reuse_pages_without_inserting_custom_ranges() {
        let path = temp_path("export_cache_policy.parquet");
        write_small(&path);
        let file = path.to_string_lossy();
        let cache = ParquetCache::new();
        let sort = SortSpec { column: "id".into(), direction: SortDirection::Asc };
        let first = super::sorted_page_batches(&cache, &file, 0, 1, None, sort.clone(),
            super::ResultCachePolicy::Populate).await.unwrap();
        let keys = || cache.results.lock().unwrap().iter().map(|r| r.query.clone()).collect::<Vec<_>>();
        let before = keys();
        let hit = super::sorted_page_batches(&cache, &file, 0, 1, None, sort.clone(),
            super::ResultCachePolicy::ReuseOnly).await.unwrap();
        assert!(Arc::ptr_eq(first[0].column(0), hit[0].column(0)));
        let other = super::sorted_page_batches(&cache, &file, 1, 1, Some("id > 0".into()), sort,
            super::ResultCachePolicy::ReuseOnly).await.unwrap();
        assert_eq!(super::batches_to_rows(&other).unwrap()[0]["id"], 2);
        assert_eq!(keys(), before);
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
                    .map(|(b, _, _, _)| b)
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

    #[tokio::test]
    async fn eviction_releases_access_even_if_the_result_cache_is_poisoned() {
        let path = temp_path("poisoned_results.parquet");
        write_small(&path);
        let file = path.to_string_lossy();
        let (cache, fake) = cache_over_recorded_file(&file);
        cache.get_or_create_metadata(&file).await.unwrap();
        super::count_data(&cache, &file, None).await.unwrap();
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = cache.results.lock().unwrap();
            panic!("inject a poisoned result cache");
        }));
        assert!(poisoned.is_err());
        cache.evict(&file).await.unwrap();
        assert!(fake.active().is_empty());
        assert!(cache.metadata.lock().unwrap().is_empty());
        assert!(cache.results.lock().unwrap().is_empty());
        assert_eq!(super::count_data(&cache, &file, None).await.unwrap(), 3);
        cache.evict(&file).await.unwrap();
        assert!(fake.active().is_empty());
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

    /// A fill in flight and the switch that ends it.
    type GatedMetadataFill = (
        tokio::task::JoinHandle<Result<ParquetMetadata, String>>,
        mpsc::Sender<Result<(), String>>,
    );

    /// A metadata fill that has started and is waiting to be let go. It
    /// returns once the fill is under way, so the caller acts on a fill
    /// that is genuinely in flight rather than racing the spawn, and the
    /// sender decides whether it then succeeds or fails.
    fn spawn_gated_metadata_fill(cache: &Arc<ParquetCache>, path: &str) -> GatedMetadataFill {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<Result<(), String>>();
        let creation = {
            let cache = Arc::clone(cache);
            let path = path.to_string();
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
        (creation, release_tx)
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
        let (creation, release_tx) = spawn_gated_metadata_fill(&cache, &path);
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
        let (creation, release_tx) = spawn_gated_metadata_fill(&cache, &path);
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

    #[derive(serde::Deserialize)]
    struct TemporalWireCase {
        value: String,
    }

    /// Every shape a date or timestamp column reaches the webview in. The
    /// SQL chart plots those columns on a time axis, which means parsing
    /// these strings back into instants, and the parser is only as right as
    /// its idea of what arrow's JSON writer emits: a bare `YYYY-MM-DD`, a
    /// date-time with one to nine fraction digits and none at all when they
    /// would be zero, `Z` for UTC, and a *numeric* offset for a named zone,
    /// resolved for that instant (so a New York summer reads `-04:00` and a
    /// winter one `-05:00`). Out-of-epoch years carry a sign and more than
    /// four digits. The cases are shared with the webview's parser
    /// (`chart-time.ts`), which reads the same file: this test proves the
    /// backend renders exactly these, so that a parser change cannot quietly
    /// start describing a wire format nothing writes.
    #[tokio::test]
    async fn temporal_columns_render_in_the_shapes_the_chart_parses() {
        use arrow::array::{
            Date32Array, Date64Array, TimestampMicrosecondArray, TimestampMillisecondArray,
            TimestampNanosecondArray, TimestampSecondArray,
        };
        use arrow::datatypes::TimeUnit;
        let schema = Arc::new(Schema::new(vec![
            Field::new("d32", DataType::Date32, true),
            Field::new("d64", DataType::Date64, true),
            Field::new("ts_s", DataType::Timestamp(TimeUnit::Second, None), true),
            Field::new("ts_ms", DataType::Timestamp(TimeUnit::Millisecond, None), true),
            Field::new("ts_us", DataType::Timestamp(TimeUnit::Microsecond, None), true),
            Field::new("ts_ns", DataType::Timestamp(TimeUnit::Nanosecond, None), true),
            Field::new(
                "ts_utc",
                DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
                true,
            ),
            Field::new(
                "ts_offset",
                DataType::Timestamp(TimeUnit::Microsecond, Some("+09:00".into())),
                true,
            ),
            Field::new(
                "ts_named",
                DataType::Timestamp(TimeUnit::Second, Some("America/New_York".into())),
                true,
            ),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                // The epoch and the day either side of it, then the far ends
                // of Date32, which render with a sign and five digits of year.
                Arc::new(Date32Array::from(vec![
                    Some(19_723),
                    Some(-1),
                    Some(0),
                    Some(4_000_000),
                    Some(-4_000_000),
                ])) as ArrayRef,
                Arc::new(Date64Array::from(vec![
                    Some(1_709_164_800_000),
                    None,
                    None,
                    None,
                    None,
                ])) as ArrayRef,
                // Year one and the last second of 9999: four-digit years at both ends.
                Arc::new(TimestampSecondArray::from(vec![
                    Some(1_704_164_645),
                    Some(-1),
                    Some(0),
                    Some(-62_135_596_800),
                    Some(253_402_300_799),
                ])) as ArrayRef,
                Arc::new(TimestampMillisecondArray::from(vec![
                    Some(1_704_164_645_678),
                    Some(-1),
                    None,
                    None,
                    None,
                ])) as ArrayRef,
                Arc::new(TimestampMicrosecondArray::from(vec![
                    Some(1_704_164_645_678_901),
                    Some(-1),
                    None,
                    None,
                    None,
                ])) as ArrayRef,
                Arc::new(TimestampNanosecondArray::from(vec![
                    Some(1_704_164_645_678_901_234),
                    Some(-1),
                    None,
                    None,
                    None,
                ])) as ArrayRef,
                Arc::new(
                    TimestampMicrosecondArray::from(vec![
                        Some(1_704_164_645_678_901),
                        Some(-1),
                        Some(0),
                        None,
                        None,
                    ])
                    .with_timezone("UTC"),
                ) as ArrayRef,
                Arc::new(
                    TimestampMicrosecondArray::from(vec![
                        Some(1_704_164_645_678_901),
                        Some(-1),
                        Some(0),
                        None,
                        None,
                    ])
                    .with_timezone("+09:00"),
                ) as ArrayRef,
                // January and July of the same zone, so the offset moves with DST.
                Arc::new(
                    TimestampSecondArray::from(vec![
                        Some(1_704_164_645),
                        Some(1_720_000_000),
                        Some(0),
                        None,
                        None,
                    ])
                    .with_timezone("America/New_York"),
                ) as ArrayRef,
            ],
        )
        .unwrap();

        let rows = super::batches_to_rows(&[batch]).unwrap();
        let mut rendered: Vec<String> = rows
            .iter()
            .flat_map(|row| row.as_object().expect("a row is an object").values())
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect();
        rendered.sort();
        rendered.dedup();

        let cases: Vec<TemporalWireCase> = serde_json::from_str(include_str!(
            "../../../contracts/temporal-wire-cases.json"
        ))
        .expect("the shared temporal-wire contract must be valid JSON");
        let mut expected: Vec<String> = cases.into_iter().map(|case| case.value).collect();
        expected.sort();
        assert_eq!(
            rendered, expected,
            "the contract must list exactly the strings these columns render as"
        );
    }

    #[test]
    fn page_query_covers_every_clause_combination() {
        use super::build_page_query;
        assert_eq!(
            build_page_query(None, Some(0), Some(50)),
            "SELECT * FROM t LIMIT 50"
        );
        assert_eq!(
            build_page_query(Some("  "), Some(100), Some(50)),
            "SELECT * FROM t LIMIT 50 OFFSET 100"
        );
        assert_eq!(
            build_page_query(Some("\"id\" > 1"), None, None),
            "SELECT * FROM t WHERE \"id\" > 1"
        );
        assert_eq!(
            build_page_query(Some("\"id\" > 1"), Some(25), Some(25)),
            "SELECT * FROM t WHERE \"id\" > 1 LIMIT 25 OFFSET 25"
        );
    }

    /// A sorted page is two queries: the positions, then the rows at them;
    /// a streamed sorted export is the rows query DataFusion sorts itself.
    /// The filter sits above the numbering in both, never inside it.
    #[test]
    fn sorted_queries_number_the_rows_before_the_filter() {
        use super::{build_position_query, build_sorted_query, sort_order};
        let columns = columns_of(&[("id", ColumnKind::Integer), ("a", ColumnKind::Text)]);
        let order = sort_order(&SortSpec { column: "a".into(), direction: SortDirection::Asc }, &columns).unwrap();
        assert_eq!(
            build_position_query(None, &order, Some(25), Some(25)),
            "SELECT \"__parqsee_pos\" FROM (SELECT *, row_number() OVER () AS \"__parqsee_pos\" FROM t) \
             ORDER BY \"a\" ASC NULLS LAST, \"__parqsee_pos\" ASC LIMIT 25 OFFSET 25"
        );
        assert_eq!(
            build_position_query(Some("\"id\" > 1"), &order, Some(0), Some(25)),
            "SELECT \"__parqsee_pos\" FROM (SELECT *, row_number() OVER () AS \"__parqsee_pos\" FROM t) \
             WHERE \"id\" > 1 ORDER BY \"a\" ASC NULLS LAST, \"__parqsee_pos\" ASC LIMIT 25"
        );
        let order = sort_order(&SortSpec { column: "a".into(), direction: SortDirection::Desc }, &columns).unwrap();
        assert_eq!(
            build_sorted_query(Some("\"id\" > 1"), &order, None, None),
            "SELECT * EXCEPT (\"__parqsee_pos\") FROM (SELECT *, row_number() OVER () AS \"__parqsee_pos\" FROM t) \
             WHERE \"id\" > 1 ORDER BY \"a\" DESC NULLS FIRST, \"__parqsee_pos\" DESC"
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

    #[tokio::test]
    async fn deep_full_sort_pages_match_topk_with_nulls_filters_and_mirroring() {
        use datafusion::physical_plan::{collect, limit::GlobalLimitExec, projection::ProjectionExec, sorts::sort::SortExec};

        let n = 70_000i64;
        let batch = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("id", DataType::Int64, false),
                Field::new("grp", DataType::Utf8, true),
            ])),
            vec![
                Arc::new(Int64Array::from((0..n).rev().collect::<Vec<_>>())) as ArrayRef,
                Arc::new(StringArray::from((0..n).rev().map(|i| match i % 3 {
                    0 => Some("a"), 1 => Some("b"), _ => None,
                }).collect::<Vec<_>>())),
            ],
        ).unwrap();
        let path = temp_path("deep_full_sort.parquet");
        write_parquet(&path, &batch, None);
        let file = path.to_string_lossy().to_string();
        let cache = ParquetCache::new();
        let metadata = cache.get_or_create_metadata(&file).await.unwrap();
        let ctx = cache.get_or_create_session(&file).await.unwrap();
        for direction in [SortDirection::Asc, SortDirection::Desc] {
            let sort = SortSpec { column: "grp".into(), direction };
            let order = super::sort_order(&sort, &metadata.columns).unwrap();
            for filter in [None, Some("id % 2 = 0")] {
                let total = if filter.is_some() { n as usize / 2 } else { n as usize };
                // Both sides of the midpoint take the ordinary-sort path.
                for offset in [total / 2 - 100, total / 2 + 100] {
                    let rows_query = super::build_sorted_query(filter, &order, Some(offset), Some(50));
                    let expected = ctx.sql(&rows_query).await.unwrap().collect().await.unwrap();
                    let expected = super::batches_to_rows(&expected).unwrap();
                    let query = super::build_position_query(filter, &order, Some(offset), Some(50));
                    let topk = ctx.sql(&query).await.unwrap().collect().await.unwrap();
                    let topk = super::positions_from_batches(&topk).unwrap();
                    // Fresh plan: its dynamic filter must not have been updated
                    // by executing the reference Top-K above.
                    let physical = ctx.sql(&query).await.unwrap().create_physical_plan().await.unwrap();
                    let full = super::full_sort_page_plan(physical);
                    let outer = full.downcast_ref::<ProjectionExec>().unwrap().input()
                        .downcast_ref::<GlobalLimitExec>().unwrap();
                    assert!(outer.input().downcast_ref::<SortExec>().unwrap().fetch().is_none());
                    let actual = collect(full, ctx.task_ctx()).await.unwrap();
                    assert_eq!(super::positions_from_batches(&actual).unwrap(), topk);
                    let ids: Vec<i64> = expected.iter().map(|row| row["id"].as_i64().unwrap()).collect();
                    // The position is the row's index in the file, whose ids run backwards.
                    assert_eq!(topk.iter().map(|&p| n - 1 - p as i64).collect::<Vec<_>>(), ids);

                    if filter.is_none() && offset == total / 2 - 100 {
                        // A cold export must use the same deep window even
                        // before the grid has populated its page cache.
                        let output = temp_path("deep_full_sort.csv");
                        crate::services::export::export_data(
                            &cache, file.clone(), output.to_string_lossy().into_owned(),
                            "csv".into(), Some(offset), Some(50), None, Some(sort.clone()),
                        ).await.unwrap();
                        let csv = std::fs::read_to_string(output).unwrap();
                        let exported_ids: Vec<i64> = csv.lines().skip(1)
                            .map(|line| line.split(',').next().unwrap().parse().unwrap()).collect();
                        let expected_ids: Vec<i64> = expected.iter().map(|row| row["id"].as_i64().unwrap()).collect();
                        assert_eq!(exported_ids, expected_ids);
                    }

                    let rows = super::read_data(&cache, &file, offset, 50, filter.map(str::to_owned), Some(sort.clone())).await.unwrap();
                    assert_eq!(rows, expected);
                    let hit = super::read_data(&cache, &file, offset, 50, filter.map(str::to_owned), Some(sort.clone())).await.unwrap();
                    assert_eq!(hit, rows);
                }
            }
        }
    }

    #[tokio::test]
    async fn full_page_sort_can_spill_with_a_bounded_memory_pool() {
        use datafusion::physical_plan::{collect, limit::GlobalLimitExec};

        let n = 30_000i64;
        let path = wide_text_file(n, "full_sort_spill.parquet");
        // This deliberately tiny pool needs smaller merge batches than the
        // production 2 GiB pool. Spill still processes more data than fits.
        let cache = ParquetCache::new().with_memory_limit(32 * 1024 * 1024);
        let ctx = cache.get_or_create_session(&path.to_string_lossy()).await.unwrap();
        ctx.sql("SET datafusion.execution.batch_size = 1024").await.unwrap().collect().await.unwrap();
        let plan = ctx.sql("SELECT * FROM t ORDER BY text, id LIMIT 50 OFFSET 15000")
            .await.unwrap().create_physical_plan().await.unwrap();
        let plan = super::full_sort_page_plan(plan);
        let batches = collect(Arc::clone(&plan), ctx.task_ctx()).await.unwrap();
        let rows = super::batches_to_rows(&batches).unwrap();
        assert_eq!(rows.len(), 50);
        assert_eq!(rows[0]["id"], 15000);
        assert_eq!(rows[49]["id"], 15049);
        let sort = plan.downcast_ref::<GlobalLimitExec>().unwrap().input();
        assert!(sort.metrics().unwrap().spill_count().unwrap() > 0);
    }

    /// A page too shallow for `prefer_full_page_sort` whose top-k still
    /// outgrows the pool is answered by the full sort instead of refused:
    /// long keys make the heap of `offset + limit` rows heavy long before
    /// the crossover. With the fallback disabled, the read fails.
    #[tokio::test]
    async fn a_top_k_past_the_memory_limit_falls_back_to_the_full_sort() {
        let n = 30_000i64;
        let path = wide_text_file(n, "topk_fallback.parquet");
        let file = path.to_string_lossy().to_string();
        let cache = ParquetCache::new().with_memory_limit(16 * 1024 * 1024);
        let ctx = cache.get_or_create_session(&file).await.unwrap();
        ctx.sql("SET datafusion.execution.batch_size = 1024").await.unwrap().collect().await.unwrap();
        let sort = SortSpec { column: "text".into(), direction: SortDirection::Asc };
        let offset = 15_000usize;
        assert!(!super::prefer_full_page_sort(offset, n as usize));

        let order = super::sort_order(&sort, &cache.get_or_create_metadata(&file).await.unwrap().columns).unwrap();
        let query = super::build_position_query(None, &order, Some(offset), Some(50));
        let err = super::run_browse_query(&ctx, &query, false).await.unwrap_err();
        assert!(super::is_memory_exhausted(&err), "{err}");

        let rows = super::read_data(&cache, &file, offset, 50, None, Some(sort)).await.unwrap();
        assert_eq!(rows.len(), 50);
        assert_eq!(rows[0]["id"], 15_000);
        assert_eq!(rows[49]["id"], 15_049);
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
    fn sort_order_names_the_key_then_the_row_position() {
        use super::sort_order;
        let columns = columns_of(&[
            ("id", ColumnKind::Integer),
            ("Mixed \"q\"", ColumnKind::Text),
            ("tags", ColumnKind::Nested),
            ("span", ColumnKind::Other),
            ("x", ColumnKind::Float),
        ]);
        let by = |column: &str, direction| SortSpec { column: column.into(), direction };

        let order = sort_order(&by("Mixed \"q\"", SortDirection::Asc), &columns).unwrap();
        assert_eq!(order.terms, "\"Mixed \"\"q\"\"\" ASC NULLS LAST, \"__parqsee_pos\" ASC");
        assert_eq!(order.position(), "__parqsee_pos");
        let order = sort_order(&by("x", SortDirection::Desc), &columns).unwrap();
        assert_eq!(order.terms, "\"x\" DESC NULLS FIRST, \"__parqsee_pos\" DESC");
        let err = sort_order(&by("nope", SortDirection::Asc), &columns).unwrap_err();
        assert!(err.contains("nope") && err.contains("no such column"), "{err}");
        let err = sort_order(&by("tags", SortDirection::Asc), &columns).unwrap_err();
        assert!(err.contains("tags") && err.contains("no order"), "{err}");

        // A file that uses the alias itself gets a longer one.
        let columns = columns_of(&[("__parqsee_pos", ColumnKind::Integer), ("__parqsee_pos_", ColumnKind::Text)]);
        let order = sort_order(&by("__parqsee_pos", SortDirection::Asc), &columns).unwrap();
        assert_eq!(order.position(), "__parqsee_pos__");
        assert_eq!(order.terms, "\"__parqsee_pos\" ASC NULLS LAST, \"__parqsee_pos__\" ASC");
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
    async fn a_duration_column_is_reported_as_other_with_its_arrow_type() {
        let schema = Arc::new(Schema::new(vec![
            Field::new(
                "dur_ns",
                DataType::Duration(arrow::datatypes::TimeUnit::Nanosecond),
                true,
            ),
            Field::new(
                "dur_ms",
                DataType::Duration(arrow::datatypes::TimeUnit::Millisecond),
                true,
            ),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(arrow::array::DurationNanosecondArray::from(vec![
                    1_500_000_000i64,
                ])) as ArrayRef,
                Arc::new(arrow::array::DurationMillisecondArray::from(vec![1_500i64])),
            ],
        )
        .unwrap();
        let path = temp_path("duration.parquet");
        write_parquet(&path, &batch, None);

        let meta = ParquetCache::new()
            .get_or_create_metadata(&path.to_string_lossy())
            .await
            .unwrap();

        assert_eq!(meta.columns[0].kind, ColumnKind::Other);
        assert_eq!(meta.columns[0].column_type, "Duration(Nanosecond)");
        assert_eq!(meta.columns[1].kind, ColumnKind::Other);
        assert_eq!(meta.columns[1].column_type, "Duration(Millisecond)");
        // The header labels a column by its logical type, so the Arrow type
        // has to land there too or it reads INT64.
        assert_eq!(
            meta.columns[0].logical_type.as_deref(),
            Some("Duration(Nanosecond)")
        );
        assert_eq!(meta.columns[0].physical_type, "INT64");
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
