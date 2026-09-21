//! The profiles the webview is still waiting for.
//!
//! A panel that changes column, or whose filter moves under it, asks again
//! and drops the answer to what it asked before. Nothing used to drop the
//! query: it kept scanning, and — because a profile's `COUNT(DISTINCT)`
//! cannot spill and reserves its hash table out of the file session's memory
//! pool — the scan nobody wanted could leave nothing for the one the panel
//! is waiting for. On a 58M-row file, clicking along four columns ended with
//! the profile on screen refused for want of memory while the abandoned one
//! ran to completion. A profile that merely takes its time never disturbed
//! the grid's own reads, so the memory is the whole reason this exists
//! (`scripts/qa/PERFORMANCE.md`, #30).
//!
//! The webview names each request and cancels the ones it has stopped
//! waiting for, rather than the backend guessing which of two requests
//! supersedes the other: two tabs of one file each have their own panel, and
//! a request neither of them abandoned must not be cut short.
//!
//! Cancelling is dropping the work: `select!` drops the losing future, which
//! drops the DataFusion stream, which releases its reservation. There is no
//! polling and no cancellation flag to check.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use tokio::sync::oneshot;

/// What a cancelled profile answers with. The webview asked for something
/// else by the time this is returned, and drops it unread; it is a message
/// rather than a silent `Ok` so that a caller which did wait for it — the
/// E2E bridge, a test — sees what happened.
pub const SUPERSEDED: &str = "The profile was superseded by a newer one";

/// The running profiles, by the id the webview gave each one. Tauri managed
/// state; the E2E bridge holds one of its own.
#[derive(Default)]
pub struct ProfileRequests {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl ProfileRequests {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `work`, cancellable under `id`. Without an id — a caller with
    /// nothing to cancel it from — the work simply runs.
    pub async fn run<T, F>(&self, id: Option<String>, work: F) -> Result<T, String>
    where
        F: Future<Output = Result<T, String>>,
    {
        let Some(id) = id else { return work.await };
        let (tx, rx) = oneshot::channel();
        // A second request under one id would be the webview's own mistake;
        // the older one is cancelled, as a supersession is.
        if let Some(previous) = self.lock().insert(id.clone(), tx) {
            let _ = previous.send(());
        }
        let outcome = tokio::select! {
            result = work => result,
            // Fires on a send and on a drop alike, so a cancel that races
            // the map entry away still ends the work.
            _ = rx => Err(SUPERSEDED.to_string()),
        };
        self.lock().remove(&id);
        outcome
    }

    /// Stop the profile `id` names. Unknown ids — already finished, never
    /// started, cancelled twice — are nothing to report: the webview cancels
    /// without waiting to see whether the work is still going.
    pub fn cancel(&self, id: &str) {
        if let Some(running) = self.lock().remove(id) {
            let _ = running.send(());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<()>>> {
        // Nothing awaits under this lock, so a poisoned one can only come
        // from a panic between the two statements that hold it.
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn a_cancelled_profile_stops_and_says_so() {
        let requests = Arc::new(ProfileRequests::new());
        let running = Arc::clone(&requests);
        let (started, was_started) = oneshot::channel();
        let task = tokio::spawn(async move {
            running
                .run(
                    Some("panel-1".into()),
                    async {
                        started.send(()).unwrap();
                        // The work the webview stopped waiting for: without
                        // cancellation this would never end.
                        std::future::pending::<Result<u8, String>>().await
                    },
                )
                .await
        });
        was_started.await.unwrap();
        requests.cancel("panel-1");
        assert_eq!(task.await.unwrap(), Err(SUPERSEDED.to_string()));
    }

    #[tokio::test]
    async fn a_profile_that_finishes_leaves_nothing_to_cancel() {
        let requests = ProfileRequests::new();
        let answer = requests.run(Some("panel-1".into()), async { Ok(7u8) }).await;
        assert_eq!(answer, Ok(7));
        assert!(requests.lock().is_empty(), "the finished request is still registered");
        // Cancelling what has already answered is a no-op, not an error.
        requests.cancel("panel-1");
    }

    #[tokio::test]
    async fn one_panel_does_not_cancel_another() {
        let requests = Arc::new(ProfileRequests::new());
        let running = Arc::clone(&requests);
        let (started, was_started) = oneshot::channel();
        let task = tokio::spawn(async move {
            running
                .run(Some("panel-1".into()), async {
                    started.send(()).unwrap();
                    std::future::pending::<Result<u8, String>>().await
                })
                .await
        });
        was_started.await.unwrap();
        requests.cancel("panel-2");
        assert!(!task.is_finished(), "another panel's cancel ended this one");
        requests.cancel("panel-1");
        assert_eq!(task.await.unwrap(), Err(SUPERSEDED.to_string()));
    }

    #[tokio::test]
    async fn a_request_without_an_id_just_runs() {
        let requests = ProfileRequests::new();
        assert_eq!(requests.run(None, async { Ok(3u8) }).await, Ok(3));
        assert!(requests.lock().is_empty());
    }
}
