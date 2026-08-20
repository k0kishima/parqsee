use arrow::record_batch::RecordBatch;
use parquet::file::reader::{FileReader, SerializedFileReader};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::sync::{Arc, Mutex};

use crate::models::{ColumnInfo, ColumnKind, ParquetMetadata};

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
    ///
    /// # Single-partition execution — a deliberate trade-off
    ///
    /// Sessions are created with `target_partitions = 1`, so **everything that
    /// runs through this context — paged reads, filtered exports, and the SQL
    /// view — executes single-threaded.**
    ///
    /// Why: the browse grid and the filtered export page with `LIMIT`/`OFFSET`
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
        // Check cache first
        {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(ctx) = sessions.get(path) {
                return Ok(ctx.clone());
            }
        }

        // Create the session and register the parquet file. Single partition,
        // deliberately — see the trade-off note in this function's doc.
        let config = datafusion::execution::context::SessionConfig::new()
            .with_target_partitions(1)
            // Lets the SQL view answer SHOW TABLES / SHOW COLUMNS FROM t.
            .with_information_schema(true);
        let ctx = datafusion::execution::context::SessionContext::new_with_config(config);
        register_file_as_t(&ctx, path).await?;

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
/// Statistics collection stays off: with it on, DataFusion 40's selectivity
/// estimate does interval arithmetic on the row-group min/max, and a 64-bit
/// column holding a value at its type's limit (a u64 hash, an i64 sentinel)
/// overflows it — every `=` filter on such a file then fails with
/// "Selectivity is out of limit", and panics in debug builds. The browse
/// grid gains nothing from the statistics anyway.
async fn register_file_as_t(
    ctx: &datafusion::execution::context::SessionContext,
    path: &str,
) -> Result<(), String> {
    use datafusion::datasource::file_format::parquet::ParquetFormat;
    use datafusion::datasource::listing::ListingOptions;

    let file_path = std::path::Path::new(path);
    let url = url::Url::from_file_path(file_path)
        .map_err(|_| format!("Failed to register parquet file: not an absolute path: {}", path))?;
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

    match field.get_basic_info().logical_type() {
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

    if let Some(logical_type) = field.get_basic_info().logical_type() {
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
            LogicalType::Unknown => ColumnKind::Other,
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
            let physical_type = if field.is_primitive() {
                format!("{:?}", field.get_physical_type())
            } else {
                group_type_to_string(field)
            };
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
                kind: column_kind(field),
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

use arrow::array::{Array, ArrayRef, FixedSizeListArray, GenericListArray, MapArray, StructArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::json::LineDelimitedWriter;

/// True for types whose values JSON cannot carry faithfully: decimals (the
/// arrow JSON writers refuse them outright) and floats (NaN and the infinities
/// have no JSON spelling, so the writer silently emits `null` for them).
fn contains_json_unsafe(data_type: &DataType) -> bool {
    match data_type {
        DataType::Decimal128(_, _)
        | DataType::Decimal256(_, _)
        | DataType::Float16
        | DataType::Float32
        | DataType::Float64 => true,
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
fn non_finite_floats_as_strings(array: &ArrayRef) -> Result<ArrayRef, String> {
    use arrow::array::{AsArray, StringArray};
    use arrow::datatypes::{Float16Type, Float32Type, Float64Type};

    let has_non_finite = match array.data_type() {
        DataType::Float16 => array
            .as_primitive::<Float16Type>()
            .iter()
            .flatten()
            .any(|v| !v.to_f32().is_finite()),
        DataType::Float32 => array.as_primitive::<Float32Type>().iter().flatten().any(|v| !v.is_finite()),
        DataType::Float64 => array.as_primitive::<Float64Type>().iter().flatten().any(|v| !v.is_finite()),
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
                other => other,
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
    let mut converted_fields = Vec::with_capacity(fields.len());
    let mut converted_columns = Vec::with_capacity(fields.len());
    for (field, column) in fields.iter().zip(array.columns()) {
        let column = json_unsafe_as_strings(column)?;
        converted_fields.push(retyped_field(field, column.data_type()));
        converted_columns.push(column);
    }
    StructArray::try_new(converted_fields.into(), converted_columns, array.nulls().cloned())
        .map_err(|e| e.to_string())
}

fn json_unsafe_as_strings(array: &ArrayRef) -> Result<ArrayRef, String> {
    if !contains_json_unsafe(array.data_type()) {
        return Ok(array.clone());
    }
    match array.data_type() {
        DataType::Decimal128(_, _) | DataType::Decimal256(_, _) => {
            arrow::compute::cast(array, &DataType::Utf8)
                .map_err(|e| format!("Failed to render decimal column: {}", e))
        }
        DataType::Float16 | DataType::Float32 | DataType::Float64 => {
            non_finite_floats_as_strings(array)
        }
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
/// strings — exact, and distinguishable from NULL — and leave every other
/// column alone.
pub fn json_unsafe_to_strings(batch: &RecordBatch) -> Result<RecordBatch, String> {
    let schema = batch.schema();
    if !schema.fields().iter().any(|f| contains_json_unsafe(f.data_type())) {
        return Ok(batch.clone());
    }

    let mut fields = Vec::with_capacity(schema.fields().len());
    let mut columns = Vec::with_capacity(schema.fields().len());
    for (field, column) in schema.fields().iter().zip(batch.columns()) {
        let column = json_unsafe_as_strings(column)?;
        fields.push(Arc::new(Field::new(
            field.name(),
            column.data_type().clone(),
            field.is_nullable(),
        )));
        columns.push(column);
    }

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

    let mut values: Vec<Option<String>> = Vec::with_capacity(column.len());
    for row in serde_json::Deserializer::from_slice(&bytes).into_iter::<serde_json::Map<String, Value>>() {
        // A null value is written as an object without the field.
        let mut row = row.map_err(|e| format!("Failed to render nested column: {}", e))?;
        values.push(row.remove(name).map(|v| v.to_string()));
    }

    Ok(Arc::new(arrow::array::StringArray::from(values)) as ArrayRef)
}

/// Arrow's CSV writer refuses nested columns ("Nested type List(...) is not
/// supported in CSV"). Serialize them as JSON text so a file with an array or
/// a struct column still exports.
pub fn nested_to_json_strings(batch: &RecordBatch) -> Result<RecordBatch, String> {
    let schema = batch.schema();
    if !schema.fields().iter().any(|f| is_nested(f.data_type())) {
        return Ok(batch.clone());
    }

    let mut fields = Vec::with_capacity(schema.fields().len());
    let mut columns = Vec::with_capacity(schema.fields().len());
    for (field, column) in schema.fields().iter().zip(batch.columns()) {
        if is_nested(field.data_type()) {
            fields.push(Arc::new(Field::new(field.name(), DataType::Utf8, true)));
            columns.push(nested_column_as_json(field.name(), column)?);
        } else {
            fields.push(field.clone());
            columns.push(column.clone());
        }
    }

    RecordBatch::try_new(Arc::new(Schema::new(fields)), columns).map_err(|e| e.to_string())
}

fn batches_to_json_bytes(batches: &[RecordBatch]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    {
        let mut writer = LineDelimitedWriter::new(&mut buf);
        for batch in batches {
            writer
                .write(&json_unsafe_to_strings(batch)?)
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

    // The walk touches every value, so skip it for schemas that cannot hold
    // an unsafe integer (mirrors json_unsafe_to_strings' early return).
    let may_overflow = batches
        .first()
        .is_some_and(|b| b.schema().fields().iter().any(|f| contains_big_integer(f.data_type())));
    if may_overflow {
        rows.iter_mut().for_each(stringify_unsafe_integers);
    }

    Ok(rows)
}

/// The largest integer a JS number represents exactly.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

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

fn where_clause(filter: Option<&str>) -> Option<&str> {
    filter.map(str::trim).filter(|f| !f.is_empty())
}

/// The one `SELECT * FROM t ...` shape the browse grid and the filtered
/// export share. Building it in one place keeps the exported rows the same
/// rows the grid paginates over.
pub fn build_page_query(
    filter: Option<&str>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> String {
    let mut query = String::from("SELECT * FROM t");
    if let Some(f) = where_clause(filter) {
        query.push_str(&format!(" WHERE {}", f));
    }
    if let Some(limit) = limit {
        query.push_str(&format!(" LIMIT {}", limit));
    }
    if let Some(offset) = offset.filter(|o| *o > 0) {
        query.push_str(&format!(" OFFSET {}", offset));
    }
    query
}

pub async fn read_data(
    cache: &ParquetCache,
    path: &str,
    offset: usize,
    limit: usize,
    filter: Option<String>,
) -> Result<Vec<Value>, String> {
    let query = build_page_query(filter.as_deref(), Some(offset), Some(limit));

    let (batches, _) = execute_sql_with_cache(cache, path, &query).await?;

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

    // Plan first and execute second: `SessionContext::sql` would run DDL and
    // SET statements while planning, and this session is shared with the
    // browse grid — a `DROP TABLE t` took paging down with it, and a `SET
    // target_partitions` silently voided the single-partition ordering
    // guarantee. The viewer only ever reads, so anything that would change
    // the session or touch the filesystem is rejected before it runs.
    let plan = ctx
        .state()
        .create_logical_plan(query)
        .await
        .map_err(|e| format!("SQL execution failed: {}", e))?;
    reject_non_query(&plan)?;
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
    use super::{truncate_batches, ParquetCache};
    use crate::models::ColumnKind;
    use arrow::array::{
        Array, ArrayRef, Decimal128Array, Decimal128Builder, FixedSizeListBuilder, Int32Array,
        Int32Builder, Int64Array, ListBuilder, MapBuilder, StringArray, StringBuilder, StructArray,
    };
    use arrow::datatypes::{DataType, Field, Fields, Schema};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use std::fs::File;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("parqsee-parquet-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
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
        let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
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
        let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
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
        let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 1, None)
            .await
            .expect("decimals inside maps and fixed-size lists must not fail the read");

        assert_eq!(rows[0]["m"]["price"], "1.50");
        assert_eq!(rows[0]["pair"][0], "1.00");
        assert_eq!(rows[0]["pair"][1], "2.00");
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
                ])) as ArrayRef,
                Arc::new(arrow::array::Float32Array::from(vec![Some(2.0), None, None, None, None])),
                Arc::new(arrow::array::Float64Array::from(vec![Some(0.1 + 0.2), None, None, None, None])),
            ],
        )
        .unwrap();
        let path = temp_path("nan.parquet");
        let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 5, None)
            .await
            .unwrap();
        assert_eq!(rows[0]["x"], "NaN");
        assert_eq!(rows[1]["x"], "Infinity");
        assert_eq!(rows[2]["x"], "-Infinity");
        // A column that had to be rendered keeps its finite values readable.
        assert_eq!(rows[3]["x"], "1.5");
        assert!(rows[4].get("x").is_none());
        // Columns without a non-finite value stay numbers.
        assert_eq!(rows[0]["y"], 2.0);
        assert_eq!(rows[0]["plain"], 0.1 + 0.2);
    }

    #[tokio::test]
    async fn decimal_columns_reach_the_webview_as_exact_strings() {
        let path = write_decimal_fixture();
        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 2, None)
            .await
            .expect("decimal columns must not fail the read");

        assert_eq!(rows[0]["amount"], "12345.6789");
        assert_eq!(rows[1]["amount"], "-0.0001");
        assert_eq!(rows[0]["prices"][0], "1.50");
        assert_eq!(rows[0]["line"]["net"], "0.5000");
    }

    fn write_small(path: &PathBuf) {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false)]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int64Array::from(vec![1, 2, 3])) as ArrayRef],
        )
        .unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut writer = ArrowWriter::try_new(File::create(path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
    }

    /// macOS is case-insensitive, so `DATA.PARQUET` is a perfectly ordinary
    /// file name there; the listing must not drop it for its extension.
    #[tokio::test]
    async fn reads_files_with_an_uppercase_extension() {
        let path = temp_path("UPPER.PARQUET");
        write_small(&path);
        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 10, None)
            .await
            .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(super::count_data(&cache, &path.to_string_lossy(), None).await.unwrap(), 3);
    }

    /// Glob characters are legal in file names; they must not be treated as
    /// a pattern over the parent directory.
    #[tokio::test]
    async fn reads_files_whose_names_contain_glob_characters() {
        for name in ["glob[1].parquet", "what?.parquet", "star*.parquet", "sp ace.parquet", "pct%20.parquet"] {
            let path = temp_path("globs").join(name);
            write_small(&path);
            let cache = ParquetCache::new();
            let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 10, None)
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
            async move { super::execute_sql_limited(cache, &file, q, Some(10)).await.map(|(b, _, _)| b) }
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
        let rows = super::read_data(&cache, &file, 0, 10, None).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(run("SELECT * FROM t LIMIT 100;").await.unwrap().iter().map(|b| b.num_rows()).sum::<usize>(), 3);
        assert!(run("EXPLAIN SELECT * FROM t").await.is_ok(), "EXPLAIN must not be limited");
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
        let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let cache = ParquetCache::new();
        let file = path.to_string_lossy().to_string();
        for (filter, expected) in [("\"hash\" = 1", 1), ("\"score\" = 1.5", 1), ("\"id\" = 7", 1), ("\"hash\" = 18446744073709551615", 1)] {
            let rows = super::read_data(&cache, &file, 0, 10, Some(filter.to_string()))
                .await
                .unwrap_or_else(|e| panic!("{filter}: {e}"));
            assert_eq!(rows.len(), expected, "{filter}");
            assert_eq!(super::count_data(&cache, &file, Some(filter.to_string())).await.unwrap(), expected, "{filter}");
        }
    }

    #[test]
    fn page_query_covers_every_clause_combination() {
        use super::build_page_query;
        assert_eq!(build_page_query(None, Some(0), Some(50)), "SELECT * FROM t LIMIT 50");
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
                Arc::new(Int64Array::from(vec![9007199254740993i64, -9007199254740993i64]))
                    as ArrayRef,
                Arc::new(Int64Array::from(vec![42i64, 9007199254740991i64])),
                Arc::new(nested),
            ],
        )
        .unwrap();
        let path = temp_path("big_ints.parquet");
        let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let cache = ParquetCache::new();
        let rows = super::read_data(&cache, &path.to_string_lossy(), 0, 2, None)
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

    #[test]
    fn metadata_classifies_primitive_columns_structurally() {
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
        let mut writer = ArrowWriter::try_new(File::create(&path).unwrap(), schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();

        let meta = ParquetCache::new()
            .get_or_create_metadata(&path.to_string_lossy())
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

    #[test]
    fn metadata_labels_group_columns_instead_of_panicking() {
        let path = write_nested_fixture();
        let cache = ParquetCache::new();
        let meta = cache
            .get_or_create_metadata(&path.to_string_lossy())
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
