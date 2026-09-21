use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct ParquetMetadata {
    pub num_rows: i64,
    pub num_columns: usize,
    pub columns: Vec<ColumnInfo>,
}

/// What a column structurally is, independent of how its type is labelled.
/// The filter bar decides quoting from this; the display strings
/// (`column_type` etc.) are free to change wording without affecting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "ipc/")]
pub enum ColumnKind {
    Boolean,
    Integer,
    Float,
    Decimal,
    Text,
    Temporal,
    Binary,
    Nested,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct ColumnInfo {
    pub name: String,
    pub column_type: String,
    pub kind: ColumnKind,
    pub logical_type: Option<String>,
    pub physical_type: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// One row of a directory listing. `size` is set for files, `children`
/// only by the webview once it has listed the directory itself.
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub is_parquet: bool,
    #[ts(optional = nullable)]
    pub size: Option<u64>,
    #[ts(optional = nullable)]
    pub children: Option<Vec<FileEntry>>,
}

/// A folder the user opened as a workspace root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct WorkspaceRoot {
    pub path: String,
    pub name: String,
}

/// One Recent Files entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Unix time in milliseconds; the webview formats it.
    pub last_accessed: i64,
    /// False when the file cannot be reached any more (deleted, or the
    /// bookmark no longer resolves); the list shows it greyed out.
    pub available: bool,
}

/// The part of a tab's view state worth restoring after a relaunch. Every
/// field is optional: the webview sends what the tab has set, and reads
/// back what was saved with the tab's own defaults for the rest.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct SessionTabState {
    /// `browse` or `query`.
    #[serde(default)]
    pub view_mode: Option<String>,
    /// 1-based page of the browse grid.
    #[serde(default)]
    pub current_page: Option<u32>,
    /// The SQL `WHERE` fragment the browse grid applies.
    #[serde(default)]
    pub active_filter: Option<String>,
    /// The column the browse grid is sorted by, if any.
    #[serde(default)]
    pub sort: Option<SortSpec>,
}

/// The order the browse grid shows its rows in: one column, ascending or
/// descending. What the header's sort button sets, and what a page read
/// and an export carry so they walk the same sequence. `None` anywhere a
/// sort is optional means file order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct SortSpec {
    pub column: String,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "ipc/")]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    pub fn reversed(self) -> Self {
        match self {
            SortDirection::Asc => SortDirection::Desc,
            SortDirection::Desc => SortDirection::Asc,
        }
    }
}

/// A tab from the last session, as the webview reopens it at launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct SessionTab {
    pub path: String,
    pub name: String,
    pub state: SessionTabState,
    /// False when the file cannot be reached any more (deleted, or the
    /// bookmark no longer resolves); the webview skips it and says so.
    pub available: bool,
}

/// The tabs of the last session, in their order, and the active one's path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct SessionTabs {
    pub tabs: Vec<SessionTab>,
    pub active: Option<String>,
}

/// What the webview sends to `save_session` for each open tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct SessionTabInput {
    pub path: String,
    #[serde(default)]
    pub state: SessionTabState,
}

/// Whether the one-time purchase is owned; derived by
/// `services::store::License` from the App Store entitlements, never
/// stored by the webview. The free tier's limits are the webview's
/// business (see `features/license/lib/license.ts`); the backend only
/// answers "is the full version owned".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "ipc/")]
pub enum IapState {
    /// The full version is not owned: the free tier, limited by feature.
    Free,
    /// The full version is owned.
    Unlocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct IapStatus {
    pub state: IapState,
    /// Set when the entitlements could not be read from the App Store; the
    /// app is then on the free tier and the screens can say why.
    pub store_error: Option<String>,
    /// Whether this build talks to a store at all. False in every build
    /// without one (the plain `pnpm tauri build`, dev, the e2e bridge), where
    /// the app is unlocked and the purchase screens have nothing to show.
    pub has_store: bool,
    /// Counts the changes to the backend's purchase state in this process:
    /// 1 at the launch-time read, one more for every purchase, restore and
    /// transaction update; 0 for a status derived from no read at all
    /// (`iap_status` giving up its wait). The `iap-status` event and a
    /// command's answer can cross on their way to the webview, which keeps
    /// whichever carries the higher number.
    pub revision: u64,
}

/// A product as the App Store describes it in the user's storefront —
/// name, description and price are App Store Connect's, not the app's.
/// The webview buys by the `id` it got from here and carries none of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct IapProduct {
    pub id: String,
    pub display_name: String,
    pub description: String,
    /// Localized, currency included (`¥1,500`, `$9.99`).
    pub display_price: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "ipc/")]
pub enum IapPurchaseOutcome {
    Purchased,
    Cancelled,
    /// Waiting on something outside the app (Ask to Buy, a payment
    /// review); `Transaction.updates` delivers the result later.
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct IapPurchaseResult {
    pub outcome: IapPurchaseOutcome,
    /// The status after the purchase was accounted for.
    pub status: IapStatus,
}

/// What a SQL result column can be on a chart, decided from the result's
/// Arrow schema. The webview cannot decide this itself: `data_type` is the
/// type's display string, which is free to change wording, and the file's
/// `ColumnInfo` describes the file, not a query — `CAST`, arithmetic and
/// aggregates all change the type. Only the two things a chart needs are
/// distinguished: how to parse the values (`batches_to_rows` renders
/// decimals and big integers as strings) and whether the column is a
/// continuous axis.
///
/// Dictionary-encoded columns are `unsupported` rather than mapped to their
/// value type: the JSON rendering of a dictionary's decimals and non-finite
/// floats is not tested to match a plain column's, so the webview would be
/// parsing values it cannot trust. A `CAST` in the query unwraps them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "ipc/")]
pub enum QueryChartType {
    Integer,
    Float,
    Decimal,
    Date,
    Timestamp {
        /// Arrow's timezone string, `None` for a wall-clock timestamp.
        timezone: Option<String>,
    },
    /// Strings, booleans and times of day: a label per row, no axis.
    Category,
    /// Binary, nested, interval and everything else: the query has to
    /// `CAST` it to something chartable.
    Unsupported,
}

/// One column of a SQL result: the name the query gave it and its Arrow type
/// rendered for display. Not `ColumnInfo` — that describes a column of the
/// parquet file itself, and a query's columns can be computed, joined or
/// aggregated, where a physical or logical parquet type means nothing.
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct QueryColumn {
    pub name: String,
    pub data_type: String,
    pub chart_type: QueryChartType,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct QueryResult {
    pub columns: Vec<QueryColumn>,
    /// One JSON object per row, already rendered webview-safe by
    /// `batches_to_rows` (decimals and big integers as strings).
    #[ts(type = "Record<string, unknown>[]")]
    pub rows: Vec<serde_json::Value>,
    pub execution_time_ms: u128,
    /// True when the result was cut at `max_rows`.
    pub truncated: bool,
    pub max_rows: usize,
    /// How to ask about these rows again — profiling a column of them, or
    /// narrowing them. None when the result was too large to keep, which
    /// is the panel's reason for having nothing to show.
    pub result_id: Option<String>,
}

/// One value of a column and how many rows hold it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct ValueCount {
    /// Rendered like a grid cell (`batches_to_rows`), so the webview shows
    /// it as the grid does and can type it back into a filter as it is.
    #[ts(type = "unknown")]
    pub value: serde_json::Value,
    pub count: usize,
}

/// One bucket: `lower <= value < upper`, or `<= upper` when
/// `upper_inclusive` is set. Both ends are SQL
/// literals a filter on the column accepts as typed — bare numbers, or a
/// date / time / timestamp in the text arrow renders it with — so a click on
/// the bucket becomes a pair of comparisons without another
/// rendering step. The last time-of-day bucket uses an inclusive upper
/// bound at the final representable instant of the day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct HistogramBucket {
    pub lower: String,
    pub upper: String,
    pub upper_inclusive: bool,
    pub count: usize,
}

/// The chart a column profile carries; which one is
/// `services::profile`'s decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "shape", rename_all = "snake_case")]
#[ts(export, export_to = "ipc/")]
pub enum ProfileChart {
    /// Values with their counts, commonest first. `other` is the number of
    /// non-null rows whose value is not listed — 0 when the list is complete.
    TopValues {
        values: Vec<ValueCount>,
        other: usize,
    },
    /// Equal-width buckets in value order over the column's range. `other`
    /// is the number of non-null values no bucket holds: NaN and the
    /// infinities of a float column.
    Histogram {
        buckets: Vec<HistogramBucket>,
        other: usize,
    },
    /// A type the profile has no chart for (nested, interval); the counts
    /// still apply.
    Unsupported,
}

/// What one column holds under the grid's filter, in the numbers the panel
/// shows above its chart. The first of the two answers a profile is made of
/// (`services::profile`): they arrive separately because the counts take a
/// scan and the chart takes another, and on a large file the panel would
/// otherwise show nothing until both were done. The chart is chosen from
/// these counts, so the second call is given them back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ipc/")]
pub struct ColumnCounts {
    pub column: String,
    pub kind: ColumnKind,
    /// Rows under the filter — the count the grid's footer shows.
    pub total_rows: usize,
    pub null_count: usize,
    /// Distinct non-null values; absent for a type the count is not
    /// defined on (nested, interval).
    pub distinct_count: Option<usize>,
    /// Whether `distinct_count` is an estimate. An exact count keeps every
    /// distinct value in memory and cannot spill, so on a large column it
    /// asks for more than the session's memory pool has; the profile then
    /// estimates rather than failing, and says so here — a number the panel
    /// prints unqualified would be read as the count it is not.
    pub distinct_approximate: bool,
}
