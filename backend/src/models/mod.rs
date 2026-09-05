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

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub is_parquet: bool,
    pub size: Option<u64>,
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
