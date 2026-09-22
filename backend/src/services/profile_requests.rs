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
//!
//! The SQL view's runs are registered here as well (`execute_sql`,
//! `cancel_query`), for a reason of the same shape: the session scans a
//! single partition, so a query the user has re-run or stopped would
//! otherwise hold the file's reads until it finished on its own. The ids
//! are the webview's, prefixed by what they name (`profile-…`, `query-…`),
//! so the two never collide in the one map.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
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
    running: Mutex<HashMap<String, Registration>>,
    next_run: AtomicU64,
}

/// One registered run. The serial tells two runs under the same id apart:
/// an id is the webview's to mint and it may reuse one, and a run that
/// cleared the entry without looking would cancel the run that replaced it.
struct Registration {
    run: u64,
    cancel: oneshot::Sender<()>,
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
        let run = self.next_run.fetch_add(1, Ordering::Relaxed);
        // A second request under one id would be the webview's own mistake;
        // the older one is cancelled, as a supersession is.
        if let Some(previous) = self.lock().insert(id.clone(), Registration { run, cancel: tx }) {
            let _ = previous.cancel.send(());
        }
        let outcome = tokio::select! {
            result = work => result,
            // Fires on a send and on a drop alike, so a cancel that races
            // the map entry away still ends the work.
            _ = rx => Err(SUPERSEDED.to_string()),
        };
        // Clear the entry only while it is still this run's. A run that was
        // superseded finds the newer one there and leaves it alone;
        // removing it would cancel the very request that replaced this one,
        // and both would come back superseded.
        let mut running = self.lock();
        if running.get(&id).is_some_and(|entry| entry.run == run) {
            running.remove(&id);
        }
        drop(running);
        outcome
    }

    /// Stop the profile `id` names. Unknown ids — already finished, never
    /// started, cancelled twice — are nothing to report: the webview cancels
    /// without waiting to see whether the work is still going.
    pub fn cancel(&self, id: &str) {
        if let Some(running) = self.lock().remove(id) {
            let _ = running.cancel.send(());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Registration>> {
        // Nothing awaits under this lock, so a poisoned one can only come
        // from a panic between the two statements that hold it.
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::task::JoinHandle;

    /// A run registered under `id` that has begun and will not end on its
    /// own: what every cancellation test needs before it can cancel
    /// anything. The receiver resolves once the work is under way, so a
    /// test cancels a run that exists rather than racing the spawn.
    fn spawn_pending_run(
        requests: &Arc<ProfileRequests>,
        id: &str,
    ) -> (JoinHandle<Result<u8, String>>, oneshot::Receiver<()>) {
        let running = Arc::clone(requests);
        let id = id.to_string();
        let (started, was_started) = oneshot::channel();
        let task = tokio::spawn(async move {
            running
                .run(Some(id), async {
                    started.send(()).unwrap();
                    // The work the webview stopped waiting for: without
                    // cancellation this would never end.
                    std::future::pending::<Result<u8, String>>().await
                })
                .await
        });
        (task, was_started)
    }

    #[tokio::test]
    async fn a_cancelled_profile_stops_and_says_so() {
        let requests = Arc::new(ProfileRequests::new());
        let (task, was_started) = spawn_pending_run(&requests, "panel-1");
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
        let (task, was_started) = spawn_pending_run(&requests, "panel-1");
        was_started.await.unwrap();
        requests.cancel("panel-2");
        assert!(!task.is_finished(), "another panel's cancel ended this one");
        requests.cancel("panel-1");
        assert_eq!(task.await.unwrap(), Err(SUPERSEDED.to_string()));
    }

    /// The webview does not reuse an id, but nothing stops it: the id is
    /// its to mint. The second run has to be the one that survives — it is
    /// the one whose answer the panel is waiting for.
    #[tokio::test]
    async fn a_second_request_under_one_id_supersedes_only_the_first() {
        let requests = Arc::new(ProfileRequests::new());
        let (first, first_started) = spawn_pending_run(&requests, "panel-1");
        first_started.await.unwrap();
        let (second, second_started) = spawn_pending_run(&requests, "panel-1");
        second_started.await.unwrap();

        assert_eq!(first.await.unwrap(), Err(SUPERSEDED.to_string()));
        assert!(!second.is_finished(), "the first run's cleanup cancelled the second");

        requests.cancel("panel-1");
        assert_eq!(second.await.unwrap(), Err(SUPERSEDED.to_string()));
        assert!(requests.lock().is_empty());
    }

    #[tokio::test]
    async fn a_request_without_an_id_just_runs() {
        let requests = ProfileRequests::new();
        assert_eq!(requests.run(None, async { Ok(3u8) }).await, Ok(3));
        assert!(requests.lock().is_empty());
    }
}
