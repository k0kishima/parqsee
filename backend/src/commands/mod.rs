pub mod data;
pub mod file;
pub mod query;

use futures::FutureExt;
use std::future::Future;

/// Run a command body and turn a panic into an error the webview can show.
///
/// A panic inside a Tauri command aborts the command future without ever
/// resolving the JavaScript promise — the grid sat on its spinner forever
/// and the tab could not even be refreshed. DataFusion has panicked on
/// pathological files before (see `register_file_as_t`), so every command
/// that touches a file goes through here.
pub async fn guarded<T, F>(what: &str, fut: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    match std::panic::AssertUnwindSafe(fut).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => {
            let detail = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown panic".to_string());
            Err(format!("{} failed unexpectedly: {}", what, detail))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::guarded;

    #[tokio::test]
    async fn a_panic_becomes_an_error_instead_of_a_hang() {
        let err = guarded::<(), _>("Reading", async { panic!("attempt to add with overflow") })
            .await
            .unwrap_err();
        assert_eq!(err, "Reading failed unexpectedly: attempt to add with overflow");
        assert_eq!(guarded("Reading", async { Ok::<_, String>(1) }).await, Ok(1));
    }
}
