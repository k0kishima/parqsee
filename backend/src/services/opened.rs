//! Files Finder, the Dock or `open -a Parqsee …` hands the app.
//!
//! macOS delivers them to `tauri::RunEvent::Opened` as `file://` URLs; the
//! webview learns about them through the same `file-drop` event a drag and
//! drop uses. On a cold start the event arrives before the webview has
//! registered its listener, so [`PendingOpen`] holds the paths until the
//! frontend asks for them (`take_pending_files`).

use std::sync::Mutex;
use url::Url;

/// The paths behind `file://` URLs, in order; anything else is dropped.
///
/// The URLs are percent-encoded (` ` → `%20`, `%` → `%25`, `#` → `%23`), and
/// non-ASCII names arrive as UTF-8 percent-escapes. `Url::to_file_path` is
/// the only thing that undoes that correctly — stripping the `file://`
/// prefix off the string leaves the escapes in the path and the file is not
/// found (`scripts/qa/fixtures/paths/` has one of each).
pub fn file_paths(urls: &[Url]) -> Vec<String> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[derive(Default)]
struct State {
    /// Set by the first `take`: the webview is listening from then on.
    ready: bool,
    paths: Vec<String>,
}

/// The handover of opened files to the webview (Tauri managed state).
///
/// Every path goes through one mutex, so none is lost or delivered twice:
/// what arrives before the frontend's `take` is returned by it, what arrives
/// after is emitted as `file-drop`.
#[derive(Default)]
pub struct PendingOpen {
    state: Mutex<State>,
}

impl PendingOpen {
    pub fn new() -> Self {
        Self::default()
    }

    /// A store that already holds `paths`. Only the e2e bridge builds one:
    /// it has no event loop to receive `RunEvent::Opened`, so a cold start
    /// is acted out by seeding the paths (`PARQSEE_PENDING_FILES`).
    pub fn seeded(paths: Vec<String>) -> Self {
        Self {
            state: Mutex::new(State { ready: false, paths }),
        }
    }

    /// The paths to emit now, or `None` when the webview is not listening
    /// yet and they were buffered for the next [`take`](Self::take).
    pub fn deliver(&self, paths: Vec<String>) -> Option<Vec<String>> {
        if paths.is_empty() {
            return None;
        }
        let mut state = self.lock();
        if state.ready {
            return Some(paths);
        }
        state.paths.extend(paths);
        None
    }

    /// Everything buffered so far. From now on `deliver` hands its paths
    /// back to the caller instead of buffering them.
    pub fn take(&self) -> Vec<String> {
        let mut state = self.lock();
        state.ready = true;
        std::mem::take(&mut state.paths)
    }

    /// A poisoned lock only means a panic while the buffer was held; the
    /// paths in it are still fine to use.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn url_of(path: &str) -> Url {
        Url::from_file_path(path).expect("an absolute path")
    }

    #[test]
    fn hostile_names_survive_the_url_round_trip() {
        // The names under scripts/qa/fixtures/paths/.
        let names = [
            "sp ace.parquet",
            "pct%20.parquet",
            "hash#1.parquet",
            "日本語ファイル.parquet",
            "quote'single.parquet",
            "curly{a,b}.parquet",
            "glob[1].parquet",
            "star*.parquet",
            "plus+sign.parquet",
        ];
        let paths: Vec<PathBuf> = names.iter().map(|n| PathBuf::from("/data/paths").join(n)).collect();
        let urls: Vec<Url> = paths.iter().map(|p| Url::from_file_path(p).unwrap()).collect();

        let got = file_paths(&urls);

        assert_eq!(got, paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>());
        // The escapes really were there to undo.
        assert!(urls[0].as_str().ends_with("sp%20ace.parquet"), "{}", urls[0]);
        assert!(urls[2].as_str().ends_with("hash%231.parquet"), "{}", urls[2]);
    }

    #[test]
    fn urls_that_are_not_files_are_dropped() {
        let urls = vec![
            Url::parse("https://example.com/data.parquet").unwrap(),
            url_of("/data/one.parquet"),
            Url::parse("parqsee://open").unwrap(),
        ];

        assert_eq!(file_paths(&urls), vec!["/data/one.parquet".to_string()]);
    }

    #[test]
    fn paths_arriving_before_the_webview_listens_are_buffered() {
        let pending = PendingOpen::new();

        assert_eq!(pending.deliver(vec!["/a.parquet".into()]), None);
        assert_eq!(pending.deliver(vec!["/b.parquet".into()]), None);
        assert_eq!(pending.take(), vec!["/a.parquet".to_string(), "/b.parquet".to_string()]);
        // Nothing is handed over twice.
        assert!(pending.take().is_empty());
    }

    #[test]
    fn paths_arriving_after_the_first_take_are_handed_straight_back() {
        let pending = PendingOpen::seeded(vec!["/launch.parquet".into()]);

        assert_eq!(pending.take(), vec!["/launch.parquet".to_string()]);
        assert_eq!(pending.deliver(vec!["/later.parquet".into()]), Some(vec!["/later.parquet".into()]));
        // Delivered, not kept: a reload of the webview must not reopen it.
        assert!(pending.take().is_empty());
    }

    #[test]
    fn nothing_is_delivered_for_no_paths() {
        let pending = PendingOpen::new();
        assert_eq!(pending.deliver(vec![]), None);
        pending.take();
        assert_eq!(pending.deliver(vec![]), None);
    }
}
