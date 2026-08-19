use arrow::record_batch::RecordBatch;
use parquet::file::reader::{FileReader, SerializedFileReader};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::sync::Mutex;

use crate::models::{ColumnInfo, ParquetMetadata};

/// Cache for DataFusion SessionContext and Parquet metadata.
/// Stored as Tauri managed state to avoid re-creating sessions on every request.
pub struct ParquetCache {
    sessions: Mutex<HashMap<String, datafusion::execution::context::SessionContext>>,
    metadata: Mutex<HashMap<String, ParquetMetadata>>,
}

impl ParquetCache {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            metadata: Mutex::new(HashMap::new()),
        }
    }

    /// Get or create a SessionContext for the given file path.
    /// Returns a cloned SessionContext (SessionContext uses Arc internally, so cloning is cheap).
    pub async fn get_or_create_session(
        &self,
        path: &str,
    ) -> Result<datafusion::execution::context::SessionContext, String> {
        // Check cache first
        {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(ctx) = sessions.get(path) {
                return Ok(ctx.clone());
            }
        }

        // Create new session and register the parquet file
        let ctx = datafusion::execution::context::SessionContext::new();
        let options = datafusion::prelude::ParquetReadOptions::default();
        ctx.register_parquet("t", path, options)
            .await
            .map_err(|e| format!("Failed to register parquet file: {}", e))?;

        // Store in cache
        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(path.to_string(), ctx.clone());
        }

        Ok(ctx)
    }

    /// Get cached metadata, or compute and cache it.
    pub fn get_or_create_metadata(&self, path: &str) -> Result<ParquetMetadata, String> {
        // Check cache first
        {
            let metadata_cache = self.metadata.lock().map_err(|e| e.to_string())?;
            if let Some(meta) = metadata_cache.get(path) {
                return Ok(meta.clone());
            }
        }

        // Compute metadata
        let meta = compute_metadata(path)?;

        // Store in cache
        {
            let mut metadata_cache = self.metadata.lock().map_err(|e| e.to_string())?;
            metadata_cache.insert(path.to_string(), meta.clone());
        }

        Ok(meta)
    }

    /// Remove cached entries for a given file path.
    pub fn evict(&self, path: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(path);
        }
        if let Ok(mut metadata_cache) = self.metadata.lock() {
            metadata_cache.remove(path);
        }
    }
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

/// Open a parquet file for reading. Shared by metadata inspection and export.
pub fn open_file_reader(path: &str) -> Result<SerializedFileReader<File>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    SerializedFileReader::new(file).map_err(|e| e.to_string())
}

fn compute_metadata(path: &str) -> Result<ParquetMetadata, String> {
    let reader = open_file_reader(path)?;

    let metadata = reader.metadata();
    let schema = metadata.file_metadata().schema();

    let columns: Vec<ColumnInfo> = schema
        .get_fields()
        .iter()
        .map(|field| {
            let physical_type = format!("{:?}", field.get_physical_type());
            let logical_type = if let Some(lt) = field.get_basic_info().logical_type() {
                Some(logical_type_to_string(&lt))
            } else if field.get_basic_info().converted_type() != parquet::basic::ConvertedType::NONE
            {
                Some(converted_type_to_string(field.get_basic_info().converted_type()))
            } else {
                None
            };

            ColumnInfo {
                name: field.name().to_string(),
                column_type: logical_type
                    .clone()
                    .unwrap_or_else(|| physical_type.clone()),
                logical_type,
                physical_type,
            }
        })
        .collect();

    Ok(ParquetMetadata {
        num_rows: metadata.file_metadata().num_rows(),
        num_columns: columns.len(),
        columns,
    })
}

use arrow::json::LineDelimitedWriter;

fn batches_to_json_bytes(batches: &[RecordBatch]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    {
        let mut writer = LineDelimitedWriter::new(&mut buf);
        for batch in batches {
            writer
                .write(batch)
                .map_err(|e| format!("Failed to write batch: {}", e))?;
        }
        writer
            .finish()
            .map_err(|e| format!("Failed to finish writing: {}", e))?;
    }
    Ok(buf)
}

/// Decode record batches into one deserializable value per row.
pub fn batches_to_rows<T: serde::de::DeserializeOwned>(
    batches: &[RecordBatch],
) -> Result<Vec<T>, String> {
    let buf = batches_to_json_bytes(batches)?;
    serde_json::Deserializer::from_slice(&buf)
        .into_iter::<T>()
        .collect::<Result<Vec<T>, _>>()
        .map_err(|e| format!("Failed to parse JSON results: {}", e))
}

fn build_where_clause(filter: Option<String>) -> String {
    if let Some(f) = filter {
        if !f.trim().is_empty() {
            format!("WHERE {}", f)
        } else {
            String::new()
        }
    } else {
        String::new()
    }
}

pub async fn read_data(
    cache: &ParquetCache,
    path: &str,
    offset: usize,
    limit: usize,
    filter: Option<String>,
) -> Result<Vec<Value>, String> {
    let where_clause = build_where_clause(filter);
    let query = format!(
        "SELECT * FROM t {} LIMIT {} OFFSET {}",
        where_clause, limit, offset
    );

    let (batches, _) = execute_sql_with_cache(cache, path, &query).await?;

    batches_to_rows(&batches)
}

pub async fn count_data(
    cache: &ParquetCache,
    path: &str,
    filter: Option<String>,
) -> Result<usize, String> {
    let where_clause = build_where_clause(filter);
    let query = format!("SELECT COUNT(*) FROM t {}", where_clause);

    let (batches, _) = execute_sql_with_cache(cache, path, &query).await?;

    if batches.is_empty() {
        return Ok(0);
    }

    // Extract count from the first batch
    let batch = &batches[0];
    if batch.num_rows() == 0 {
        return Ok(0);
    }

    let column = batch.column(0);
    let count = column
        .as_any()
        .downcast_ref::<arrow::array::Int64Array>()
        .ok_or_else(|| "Failed to downcast count result".to_string())?
        .value(0);

    Ok(count as usize)
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

    let mut df = ctx
        .sql(query)
        .await
        .map_err(|e| format!("SQL execution failed: {}", e))?;

    let schema = df.schema().inner().clone();

    if let Some(max) = max_rows {
        // Fetch one extra row so we can tell a full page from a truncated one.
        df = df
            .limit(0, Some(max + 1))
            .map_err(|e| format!("Failed to limit results: {}", e))?;
    }

    let mut batches = df
        .collect()
        .await
        .map_err(|e| format!("Failed to collect results: {}", e))?;

    let mut truncated = false;
    if let Some(max) = max_rows {
        truncated = truncate_batches(&mut batches, max);
    }

    Ok((batches, schema, truncated))
}

/// Drop rows past `max` across `batches`; returns true if anything was dropped.
fn truncate_batches(batches: &mut Vec<RecordBatch>, max: usize) -> bool {
    let total: usize = batches.iter().map(|b| b.num_rows()).sum();
    if total <= max {
        return false;
    }
    let mut remaining = max;
    let mut keep = 0;
    for batch in batches.iter_mut() {
        if remaining == 0 {
            break;
        }
        if batch.num_rows() > remaining {
            *batch = batch.slice(0, remaining);
        }
        remaining -= batch.num_rows();
        keep += 1;
    }
    batches.truncate(keep);
    true
}

#[cfg(test)]
mod tests {
    use super::truncate_batches;
    use arrow::array::Int32Array;
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use std::sync::Arc;

    fn batch(n: i32) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int32, false)]));
        RecordBatch::try_new(schema, vec![Arc::new(Int32Array::from_iter_values(0..n))]).unwrap()
    }

    fn rows(batches: &[RecordBatch]) -> usize {
        batches.iter().map(|b| b.num_rows()).sum()
    }

    #[test]
    fn keeps_results_within_the_limit() {
        let mut batches = vec![batch(3), batch(4)];
        assert!(!truncate_batches(&mut batches, 7));
        assert_eq!(rows(&batches), 7);
        assert!(!truncate_batches(&mut batches, 100));
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn cuts_inside_a_batch_and_drops_the_rest() {
        let mut batches = vec![batch(3), batch(4), batch(5)];
        assert!(truncate_batches(&mut batches, 5));
        assert_eq!(batches.len(), 2);
        assert_eq!(rows(&batches), 5);
        assert_eq!(batches[1].num_rows(), 2);
    }

    #[test]
    fn cuts_exactly_on_a_batch_boundary() {
        let mut batches = vec![batch(3), batch(4)];
        assert!(truncate_batches(&mut batches, 3));
        assert_eq!(batches.len(), 1);
        assert_eq!(rows(&batches), 3);
    }

    #[test]
    fn zero_limit_drops_everything() {
        let mut batches = vec![batch(3)];
        assert!(truncate_batches(&mut batches, 0));
        assert!(batches.is_empty());
    }
}
