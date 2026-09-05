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
//!
//! Workspace roots, recent files and the session persist under `PARQSEE_DATA_DIR` (default:
//! a fresh directory under the temp dir), with no security-scoped bookmarks —
//! the bridge is not sandboxed, so the harness covers the store and the
//! explorer, not the grants. There is no App Store either: `iap_status`
//! answers `unlocked` (the `AlwaysUnlocked` provider, as in every build
//! without the `app-store` feature), so the trial screens never show and
//! the row commands are never refused.
use parqsee_lib::commands::file::{get_file_info, list_directory};
use parqsee_lib::commands::query::run_query;
use parqsee_lib::models::SessionTabInput;
use parqsee_lib::services::access::{FileAccess, NoopBookmarks};
use parqsee_lib::services::export::export_data;
use parqsee_lib::services::parquet::{count_data, read_data, ParquetCache};
use parqsee_lib::services::store::{AlwaysUnlocked, License};
use serde_json::{json, Value};
use std::path::PathBuf;
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

async fn dispatch(
    cache: &ParquetCache,
    access: &FileAccess,
    license: &License,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    let v = match cmd {
        "iap_status" => json!(license.status().await),
        "iap_products" => json!(license.products().await?),
        "iap_restore" => json!(license.restore().await?),
        "iap_purchase" => json!(license.purchase(&s(&args, "productId")?).await?),
        "check_file_exists" => json!(access.file_exists(&s(&args, "path")?)),
        "remember_file" => json!(access.remember_file(&s(&args, "path")?)?),
        "list_recent_files" => json!(access.recent_files()),
        "remove_recent_file" => {
            access.forget_file(&s(&args, "path")?);
            Value::Null
        }
        "clear_recent_files" => {
            access.clear_recent();
            Value::Null
        }
        "list_workspace_roots" => json!(access.roots()),
        "add_workspace_root" => json!(access.add_root(&s(&args, "path")?)?),
        "remove_workspace_root" => {
            access.remove_root(&s(&args, "path")?);
            Value::Null
        }
        "list_session_tabs" => json!(access.session_tabs()),
        "save_session" => {
            let tabs: Vec<SessionTabInput> =
                serde_json::from_value(args.get("tabs").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("bad tabs: {e}"))?;
            access.save_session(
                tabs.into_iter().map(|t| (t.path, t.state)).collect(),
                opt_s(&args, "active"),
            )?;
            Value::Null
        }
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
        "export_data" => {
            let export_path = s(&args, "exportPath")?;
            let rows = export_data(
                cache,
                s(&args, "sourcePath")?,
                export_path.clone(),
                s(&args, "format")?,
                opt_u(&args, "offset"),
                opt_u(&args, "limit"),
                opt_s(&args, "filter"),
            )
            .await?;
            access.remember_export(&export_path);
            json!(rows)
        }
        "export_default_dir" => json!(access.export_default_dir(&s(&args, "sourcePath")?)),
        "execute_sql" => json!(run_query(cache, &s(&args, "filePath")?, &s(&args, "query")?).await?),
        other => return Err(format!("unknown command {other}")),
    };
    Ok(v)
}

#[tokio::main]
async fn main() {
    let data_dir = std::env::var_os("PARQSEE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("parqsee-bridge-{}", std::process::id())));
    let access = Arc::new(FileAccess::load(Box::new(NoopBookmarks), Some(&data_dir)));
    let cache = Arc::new(ParquetCache::with_access(Arc::clone(&access)));
    let license = Arc::new(License::new(Box::new(AlwaysUnlocked)));
    license.init().await;
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
        let access = access.clone();
        let license = license.clone();
        let out = out.clone();
        tasks.push(tokio::spawn(async move {
            let id = req["id"].clone();
            let cmd = req["cmd"].as_str().unwrap_or("").to_string();
            let args = req.get("args").cloned().unwrap_or(Value::Null);
            let delay = req.get("delayMs").and_then(|d| d.as_u64()).unwrap_or(0);
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            let resp = match dispatch(&cache, &access, &license, &cmd, args).await {
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
