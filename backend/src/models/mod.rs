use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParquetMetadata {
    pub num_rows: i64,
    pub num_columns: usize,
    pub columns: Vec<ColumnInfo>,
}

/// What a column structurally is, independent of how its type is labelled.
/// The filter bar decides quoting from this; the display strings
/// (`column_type` etc.) are free to change wording without affecting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub column_type: String,
    pub kind: ColumnKind,
    pub logical_type: Option<String>,
    pub physical_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
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
