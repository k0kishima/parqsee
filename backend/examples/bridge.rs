//! E2E bridge: exposes the Tauri command surface over line-delimited JSON on
//! stdin/stdout, so the Playwright harness in `scripts/qa/e2e/` can drive the
//! real Rust backend without the Tauri shell. Each command calls the same
//! service function its Tauri command calls; see `scripts/qa/e2e/README.md`.
//!
//! Build: `cargo build --example bridge` (the harness runs
//! `target/debug/examples/bridge`; set `BRIDGE_BIN` to use a release build).
//!
//! Request:  {"id":1,"cmd":"read_parquet_data","args":{"path":"...","offset":0,"limit":50},"delayMs":0}
//! Response: {"id":1,"ok":<value>} | {"id":1,"err":"message"}
//!
//! `delayMs` holds the response back, which is how the harness provokes the
//! stale-response races the frontend guards against.
use parqsee_lib::commands::file::{check_file_exists, get_file_info, list_directory};
use parqsee_lib::commands::query::run_query;
use parqsee_lib::services::export::export_data;
use parqsee_lib::services::parquet::{count_data, read_data, ParquetCache};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

fn s(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .ok_or_else(|| format!("missing arg {key}"))
}
fn opt_s(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|v| v.to_string())
}
fn opt_u(args: &Value, key: &str) -> Option<usize> {
    args.get(key).and_then(|v| v.as_u64()).map(|v| v as usize)
}

async fn dispatch(cache: &ParquetCache, cmd: &str, args: Value) -> Result<Value, String> {
    let v = match cmd {
        "check_file_exists" => json!(check_file_exists(s(&args, "path")?).await?),
        "open_parquet_file" => json!(cache.get_or_create_metadata(&s(&args, "path")?).await?),
        "get_file_info" => json!(get_file_info(s(&args, "path")?).await?),
        "list_directory" => json!(list_directory(s(&args, "path")?).await?),
        "read_parquet_data" => json!(
            read_data(
                cache,
                &s(&args, "path")?,
                opt_u(&args, "offset").ok_or("missing offset")?,
                opt_u(&args, "limit").ok_or("missing limit")?,
                opt_s(&args, "filter"),
            )
            .await?
        ),
        "count_parquet_data" => json!(count_data(cache, &s(&args, "path")?, opt_s(&args, "filter")).await?),
        "evict_cache" => {
            cache.evict(&s(&args, "path")?).await?;
            Value::Null
        }
        "export_data" => json!(
            export_data(
                cache,
                s(&args, "sourcePath")?,
                s(&args, "exportPath")?,
                s(&args, "format")?,
                opt_u(&args, "offset"),
                opt_u(&args, "limit"),
                opt_s(&args, "filter"),
            )
            .await?
        ),
        "execute_sql" => json!(run_query(cache, &s(&args, "filePath")?, &s(&args, "query")?).await?),
        other => return Err(format!("unknown command {other}")),
    };
    Ok(v)
}

#[tokio::main]
async fn main() {
    let cache = Arc::new(ParquetCache::new());
    let out = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut tasks = Vec::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("bad request: {e}");
                continue;
            }
        };
        let cache = cache.clone();
        let out = out.clone();
        tasks.push(tokio::spawn(async move {
            let id = req["id"].clone();
            let cmd = req["cmd"].as_str().unwrap_or("").to_string();
            let args = req.get("args").cloned().unwrap_or(Value::Null);
            let delay = req.get("delayMs").and_then(|d| d.as_u64()).unwrap_or(0);
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            let resp = match dispatch(&cache, &cmd, args).await {
                Ok(v) => json!({"id": id, "ok": v}),
                Err(e) => json!({"id": id, "err": e}),
            };
            let mut line = serde_json::to_string(&resp).unwrap();
            line.push('\n');
            let mut o = out.lock().await;
            let _ = o.write_all(line.as_bytes()).await;
            let _ = o.flush().await;
        }));
    }
    for t in tasks {
        let _ = t.await;
    }
}
