//! The rows a query returned, kept so a column of them can be profiled.
//!
//! The SQL view's grid already has the result as JSON, but JSON is what
//! `batches_to_rows` made of it: a big integer and a decimal arrive as
//! strings, a timestamp as a rendered date-time. Counting distinct values
//! or binning a range over those would be counting strings. So the Arrow
//! batches the query produced are kept here, in their own types, and the
//! profile is an aggregate over them.
//!
//! What is kept is exactly what the webview was given — at most
//! `MAX_QUERY_ROWS` rows — never the whole result of the query. A profile
//! of everything the SQL matches would have to run the query again, which
//! costs what the query costs and answers differently for a
//! non-deterministic one; the panel says which of the two it is showing
//! rather than letting the number pass for the other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use arrow::datatypes::{Field, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use datafusion::datasource::MemTable;
use datafusion::prelude::SessionContext;

/// The most one result may weigh and still be kept. A wide `SELECT *` of
/// ten thousand rows over a file of several hundred columns is tens of
/// megabytes; past this the profile is refused rather than the app
/// quietly holding a result the user cannot see the size of.
pub const MAX_RESULT_BYTES: usize = 128 << 20;
/// The most every kept result may weigh together.
pub const MAX_TOTAL_BYTES: usize = 256 << 20;
/// How many results may be kept at once, however small they are.
pub const MAX_RESULTS: usize = 8;

/// The name the profile's SQL addresses column `index` by. A result's own
/// column names cannot be used: two columns of one result may share a
/// name, and an expression's name (`count(*)`, `id * 2`) is not an
/// identifier the user chose. The names the webview shows stay in
/// `QueryResult.columns`, beside the index each one is at.
pub fn column_alias(index: usize) -> String {
    format!("c{index}")
}

/// The sizes a store holds itself to. Named so the tests can set small
/// ones: a test that had to allocate the real 128 MiB to reach a cap
/// would be measuring the allocator.
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    pub result_bytes: usize,
    pub total_bytes: usize,
    pub results: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self { result_bytes: MAX_RESULT_BYTES, total_bytes: MAX_TOTAL_BYTES, results: MAX_RESULTS }
    }
}

struct Kept {
    batches: Vec<RecordBatch>,
    schema: SchemaRef,
    /// What the grid calls each column, in the order the result has them.
    /// The schema above renamed them to their positions, and this is what
    /// the panel puts in its title.
    names: Vec<String>,
    bytes: usize,
    /// When it was kept, so the oldest goes first when the caps are reached.
    sequence: u64,
}

/// Every query result being held, keyed by the id the webview was given.
/// Tauri managed state; the E2E bridge holds one of its own.
#[derive(Default)]
pub struct QueryResults {
    kept: Mutex<HashMap<String, Kept>>,
    next: Mutex<u64>,
    caps: Caps,
}

impl QueryResults {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_caps(caps: Caps) -> Self {
        Self { caps, ..Self::default() }
    }

    /// Keep `batches` and answer with the id to profile them by, or None
    /// when the result is too large to hold. The columns are renamed to
    /// their positions on the way in (see `column_alias`); the arrays
    /// themselves are shared, not copied.
    pub fn keep(&self, batches: &[RecordBatch], schema: &SchemaRef) -> Option<String> {
        let bytes: usize = batches.iter().map(|b| b.get_array_memory_size()).sum();
        if bytes > self.caps.result_bytes {
            return None;
        }
        let aliased = Arc::new(Schema::new(
            schema
                .fields()
                .iter()
                .enumerate()
                .map(|(i, f)| Field::new(column_alias(i), f.data_type().clone(), f.is_nullable()))
                .collect::<Vec<_>>(),
        ));
        let renamed: Vec<RecordBatch> = batches
            .iter()
            .map(|b| RecordBatch::try_new(aliased.clone(), b.columns().to_vec()))
            .collect::<Result<_, _>>()
            .ok()?;

        let mut sequence = self.next.lock().unwrap();
        *sequence += 1;
        let id = format!("r{}", *sequence);
        let names = schema.fields().iter().map(|f| f.name().clone()).collect();
        let kept = Kept { batches: renamed, schema: aliased, names, bytes, sequence: *sequence };
        drop(sequence);

        let mut held = self.kept.lock().unwrap();
        held.insert(id.clone(), kept);
        evict_until_within_caps(&mut held, &id, self.caps);
        Some(id)
    }

    /// A session with the result registered as table `t`, for the same SQL
    /// a file's profile runs. Built per call: registering a `MemTable` is
    /// an `Arc` clone, unlike opening a parquet file.
    pub fn session(&self, id: &str) -> Result<SessionContext, String> {
        let held = self.kept.lock().unwrap();
        let kept = held
            .get(id)
            .ok_or_else(|| "This result is no longer available. Run the query again.".to_string())?;
        let table = MemTable::try_new(kept.schema.clone(), vec![kept.batches.clone()])
            .map_err(|e| format!("Failed to read the result: {e}"))?;
        let ctx = SessionContext::new();
        ctx.register_table("t", Arc::new(table))
            .map_err(|e| format!("Failed to read the result: {e}"))?;
        Ok(ctx)
    }

    /// The name the grid shows for column `index`, and the type its values
    /// have — what a profile needs before it can choose a chart for them.
    pub fn column(&self, id: &str, index: usize) -> Result<(String, arrow::datatypes::DataType), String> {
        let held = self.kept.lock().unwrap();
        let kept = held
            .get(id)
            .ok_or_else(|| "This result is no longer available. Run the query again.".to_string())?;
        let field = kept
            .schema
            .fields()
            .get(index)
            .ok_or_else(|| format!("This result has no column at position {index}"))?;
        Ok((kept.names[index].clone(), field.data_type().clone()))
    }

    /// Let go of a result the webview will not ask about again: a query
    /// re-run, a superseded run's answer, a closed tab.
    pub fn release(&self, id: &str) {
        self.kept.lock().unwrap().remove(id);
    }

    /// How many results are held, and how much they weigh together.
    pub fn held(&self) -> (usize, usize) {
        let held = self.kept.lock().unwrap();
        (held.len(), held.values().map(|k| k.bytes).sum())
    }
}

/// Drop the oldest results until the caps are met. `keep_id` is the one
/// just inserted, which is never the one dropped — a result is kept to be
/// profiled immediately, and evicting it here would answer the very next
/// call with "no longer available".
fn evict_until_within_caps(held: &mut HashMap<String, Kept>, keep_id: &str, caps: Caps) {
    loop {
        let total: usize = held.values().map(|k| k.bytes).sum();
        if held.len() <= caps.results && total <= caps.total_bytes {
            return;
        }
        let oldest = held
            .iter()
            .filter(|(id, _)| id.as_str() != keep_id)
            .min_by_key(|(_, k)| k.sequence)
            .map(|(id, _)| id.clone());
        match oldest {
            Some(id) => {
                held.remove(&id);
            }
            None => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{ArrayRef, Int64Array, StringArray};
    use arrow::datatypes::DataType;

    /// A two-column result whose columns share a name, as a result of
    /// `SELECT id, id FROM t` does.
    fn twins(rows: usize) -> (Vec<RecordBatch>, SchemaRef) {
        let schema: SchemaRef = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, true),
            Field::new("id", DataType::Utf8, true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int64Array::from((0..rows as i64).collect::<Vec<_>>())) as ArrayRef,
                Arc::new(StringArray::from((0..rows).map(|i| format!("n{i}")).collect::<Vec<_>>())) as ArrayRef,
            ],
        )
        .unwrap();
        (vec![batch], schema)
    }

    async fn count(store: &QueryResults, id: &str, sql: &str) -> i64 {
        let ctx = store.session(id).unwrap();
        let batches = ctx.sql(sql).await.unwrap().collect().await.unwrap();
        let batch = batches.iter().find(|b| b.num_rows() > 0).expect("a row");
        batch
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .expect("an i64")
            .value(0)
    }

    #[tokio::test]
    async fn a_kept_result_answers_sql_as_table_t() {
        let store = QueryResults::new();
        let (batches, schema) = twins(5);
        let id = store.keep(&batches, &schema).unwrap();
        assert_eq!(count(&store, &id, "SELECT COUNT(*) FROM t").await, 5);
        assert_eq!(store.held(), (1, store.held().1));
    }

    /// Two columns of one result may share a name and an expression's name
    /// is not one the user chose, so the profile addresses them by
    /// position. Both of these are `id` and neither is ambiguous here.
    #[tokio::test]
    async fn columns_are_addressed_by_position_however_they_were_named() {
        let store = QueryResults::new();
        let (batches, schema) = twins(3);
        let id = store.keep(&batches, &schema).unwrap();
        assert_eq!(count(&store, &id, "SELECT COUNT(DISTINCT c0) FROM t").await, 3);
        assert_eq!(count(&store, &id, "SELECT COUNT(DISTINCT c1) FROM t").await, 3);
        let ctx = store.session(&id).unwrap();
        assert!(ctx.sql("SELECT id FROM t").await.is_err(), "the original names are not what the result is addressed by");
    }

    #[tokio::test]
    async fn a_released_result_says_to_run_the_query_again() {
        let store = QueryResults::new();
        let (batches, schema) = twins(1);
        let id = store.keep(&batches, &schema).unwrap();
        store.release(&id);
        assert_eq!(store.held().0, 0);
        let error = store.session(&id).err().expect("a released result is gone");
        assert!(error.contains("Run the query again"), "{error}");
        // Releasing what is not there is what a second close looks like.
        store.release(&id);
    }

    #[tokio::test]
    async fn a_result_too_large_to_keep_is_not_kept_at_all() {
        let store = QueryResults::with_caps(Caps { result_bytes: 64, ..Caps::default() });
        let (batches, schema) = twins(1_000);
        assert!(store.keep(&batches, &schema).is_none());
        assert_eq!(store.held(), (0, 0));
    }

    /// The caps drop the oldest first, and never the result just kept:
    /// it is kept in order to be profiled by the very next call.
    #[tokio::test]
    async fn the_caps_drop_the_oldest_and_spare_the_newest() {
        let store = QueryResults::with_caps(Caps { results: 2, ..Caps::default() });
        let (batches, schema) = twins(1);
        let first = store.keep(&batches, &schema).unwrap();
        let second = store.keep(&batches, &schema).unwrap();
        let third = store.keep(&batches, &schema).unwrap();
        assert_eq!(store.held().0, 2);
        assert!(store.session(&first).is_err(), "the oldest went");
        assert!(store.session(&second).is_ok());
        assert!(store.session(&third).is_ok(), "the newest is the one about to be profiled");
    }

    #[tokio::test]
    async fn the_byte_cap_counts_every_result_together() {
        let (batches, schema) = twins(100);
        let one: usize = batches.iter().map(|b| b.get_array_memory_size()).sum();
        let store = QueryResults::with_caps(Caps { total_bytes: one * 2, ..Caps::default() });
        let first = store.keep(&batches, &schema).unwrap();
        store.keep(&batches, &schema).unwrap();
        store.keep(&batches, &schema).unwrap();
        assert_eq!(store.held().0, 2);
        assert!(store.session(&first).is_err());
    }
}
