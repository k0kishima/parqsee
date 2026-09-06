//! The on-disk record of what the user opened — workspace roots and recent
//! files — each with the security-scoped bookmark that reopens it on the next
//! launch. Pure data: no ObjC, so it is tested on any platform.
//!
//! Lives as `bookmarks.json` in the app data directory. Nothing in here
//! depends on the bundle identifier (the directory is resolved at run time
//! and the entries are keyed by path), so a change of identifier only moves
//! the file, it does not invalidate the format.

use crate::models::SessionTabState;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::path::Path;

/// How many recent files are kept, newest first. Under the sandbox an
/// entry is also what lets its file be reopened without picking it again,
/// so the cap is how far back that reaches. The Welcome screen shows the
/// first five and folds the rest; the top row's panel shows them all.
pub const MAX_RECENT: usize = 20;

/// How many tabs a session keeps, from the first; a bound on the store, not
/// a limit anyone is expected to reach.
pub const MAX_SESSION_TABS: usize = 50;

const CURRENT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootEntry {
    pub path: String,
    pub name: String,
    #[serde(default, with = "base64_bytes")]
    pub bookmark: Option<Vec<u8>>,
    pub added_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub last_accessed: i64,
    #[serde(default, with = "base64_bytes")]
    pub bookmark: Option<Vec<u8>>,
}

/// The folder the last export was written to, where the next save panel
/// starts. The bookmark is best effort: the save panel grants the chosen
/// file, not its folder, so under the sandbox it usually cannot be created
/// and the bare path is kept instead (the panel only needs a path, and
/// `stat` is allowed on it there).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportDirEntry {
    pub path: String,
    #[serde(default, with = "base64_bytes")]
    pub bookmark: Option<Vec<u8>>,
    pub exported_at: i64,
}

/// One tab of the last session. Carries its own bookmark rather than
/// pointing at the recent entry's: Recent Files is capped and can be
/// cleared, and a tab must reopen either way. The bytes are shared with the
/// recent entry when there is one (see `FileAccess::save_session`), so a
/// file never gets a second bookmark created for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionTabEntry {
    pub path: String,
    pub name: String,
    #[serde(default, with = "base64_bytes")]
    pub bookmark: Option<Vec<u8>>,
    #[serde(default)]
    pub state: SessionTabState,
}

/// The tabs open when the session was last saved, in tab order, and which
/// one was active (by path; a path not in `tabs` means the first one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionEntry {
    pub tabs: Vec<SessionTabEntry>,
    #[serde(default)]
    pub active: Option<String>,
    pub saved_at: i64,
}

/// `version` stays at 1 across optional additions such as `last_export`
/// and `session`: an older file reads with the field absent, and an older
/// build ignores the field it does not know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookmarkStore {
    pub version: u32,
    #[serde(default)]
    pub roots: Vec<RootEntry>,
    #[serde(default)]
    pub recent: Vec<RecentEntry>,
    #[serde(default)]
    pub last_export: Option<ExportDirEntry>,
    /// `None` in a store written before sessions were kept, and until the
    /// first save: nothing to restore, so the app starts empty.
    #[serde(default)]
    pub session: Option<SessionEntry>,
}

impl Default for BookmarkStore {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            roots: Vec::new(),
            recent: Vec::new(),
            last_export: None,
            session: None,
        }
    }
}

impl BookmarkStore {
    /// Read the store at `path`. A missing file is an empty store; so is a
    /// file that does not parse — a corrupt store must never keep the app
    /// from starting, and there is nothing in it worth more than a relaunch.
    pub fn load_from(path: &Path) -> Self {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(e) => {
                eprintln!(
                    "could not read {}: {}; starting with an empty store",
                    path.display(),
                    e
                );
                return Self::default();
            }
        };
        match serde_json::from_str(&text) {
            Ok(store) => store,
            Err(e) => {
                eprintln!(
                    "could not parse {}: {}; starting with an empty store",
                    path.display(),
                    e
                );
                Self::default()
            }
        }
    }

    /// Write the store atomically (temp file + rename), creating the
    /// directory if needed.
    pub fn save_to(&self, path: &Path) -> Result<(), String> {
        let dir = path
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {}", dir.display(), e))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)
            .map_err(|e| format!("could not write {}: {}", tmp.display(), e))?;
        std::fs::rename(&tmp, path)
            .map_err(|e| format!("could not replace {}: {}", path.display(), e))
    }

    /// The bookmark recorded for `path`, whether it is a root, a recent
    /// file or a tab of the last session.
    pub fn bookmark_for(&self, path: &str) -> Option<&[u8]> {
        self.roots
            .iter()
            .find(|r| r.path == path)
            .and_then(|r| r.bookmark.as_deref())
            .or_else(|| {
                self.recent
                    .iter()
                    .find(|r| r.path == path)
                    .and_then(|r| r.bookmark.as_deref())
            })
            .or_else(|| {
                self.session_tabs()
                    .iter()
                    .find(|t| t.path == path)
                    .and_then(|t| t.bookmark.as_deref())
            })
    }

    /// The tabs of the last session, empty when none was saved.
    pub fn session_tabs(&self) -> &[SessionTabEntry] {
        self.session
            .as_ref()
            .map(|s| s.tabs.as_slice())
            .unwrap_or(&[])
    }

    /// Replace the session with `tabs`, in order, `active` naming the
    /// active one by path. A path listed twice keeps its first entry; the
    /// list is cut at `MAX_SESSION_TABS`, and an `active` that is not among
    /// the kept tabs is dropped (the first tab is activated then).
    pub fn set_session(
        &mut self,
        tabs: Vec<SessionTabEntry>,
        active: Option<String>,
        saved_at: i64,
    ) {
        let mut kept: Vec<SessionTabEntry> = Vec::with_capacity(tabs.len().min(MAX_SESSION_TABS));
        for tab in tabs {
            if kept.len() == MAX_SESSION_TABS {
                break;
            }
            if !kept.iter().any(|t| t.path == tab.path) {
                kept.push(tab);
            }
        }
        let active = active.filter(|a| kept.iter().any(|t| &t.path == a));
        self.session = Some(SessionEntry {
            tabs: kept,
            active,
            saved_at,
        });
    }

    /// Replace the bookmark for `path` wherever it is recorded. Returns
    /// whether anything changed.
    pub fn set_bookmark(&mut self, path: &str, bookmark: Vec<u8>) -> bool {
        let mut changed = false;
        for root in self.roots.iter_mut().filter(|r| r.path == path) {
            root.bookmark = Some(bookmark.clone());
            changed = true;
        }
        for recent in self.recent.iter_mut().filter(|r| r.path == path) {
            recent.bookmark = Some(bookmark.clone());
            changed = true;
        }
        if let Some(export) = self.last_export.as_mut().filter(|e| e.path == path) {
            export.bookmark = Some(bookmark.clone());
            changed = true;
        }
        if let Some(session) = self.session.as_mut() {
            for tab in session.tabs.iter_mut().filter(|t| t.path == path) {
                tab.bookmark = Some(bookmark.clone());
                changed = true;
            }
        }
        changed
    }

    /// Add a root, replacing an entry for the same path.
    pub fn add_root(&mut self, entry: RootEntry) {
        self.roots.retain(|r| r.path != entry.path);
        self.roots.push(entry);
    }

    pub fn remove_root(&mut self, path: &str) -> bool {
        let before = self.roots.len();
        self.roots.retain(|r| r.path != path);
        self.roots.len() != before
    }

    /// Put `entry` at the front of the recent list, dropping an older entry
    /// for the same path and anything beyond `MAX_RECENT`.
    pub fn upsert_recent(&mut self, entry: RecentEntry) {
        self.recent.retain(|r| r.path != entry.path);
        self.recent.insert(0, entry);
        self.recent.truncate(MAX_RECENT);
    }

    pub fn remove_recent(&mut self, path: &str) -> bool {
        let before = self.recent.len();
        self.recent.retain(|r| r.path != path);
        self.recent.len() != before
    }

    pub fn clear_recent(&mut self) {
        self.recent.clear();
    }
}

/// `Option<Vec<u8>>` as a base64 string (or `null`) in the JSON.
mod base64_bytes {
    use super::*;

    pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(bytes) => s.serialize_some(&BASE64.encode(bytes)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        let text: Option<String> = Option::deserialize(d)?;
        text.map(|t| BASE64.decode(t).map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::test_support::temp_path;

    fn recent(path: &str, at: i64) -> RecentEntry {
        RecentEntry {
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap().to_string(),
            size: 1,
            last_accessed: at,
            bookmark: Some(vec![0, 255, 7]),
        }
    }

    #[test]
    fn round_trips_through_json_with_base64_bookmarks() {
        let file = temp_path("access-store", "round-trip/bookmarks.json");
        let mut store = BookmarkStore::default();
        store.add_root(RootEntry {
            path: "/data".into(),
            name: "data".into(),
            bookmark: Some(vec![1, 2, 3]),
            added_at: 10,
        });
        store.upsert_recent(recent("/data/a.parquet", 20));
        store.last_export = Some(ExportDirEntry {
            path: "/exports".into(),
            bookmark: Some(vec![4, 5]),
            exported_at: 30,
        });
        store.save_to(&file).unwrap();

        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"bookmark\": \"AQID\""), "{text}");
        assert!(!file.with_extension("json.tmp").exists());
        assert_eq!(BookmarkStore::load_from(&file), store);
    }

    #[test]
    fn a_missing_or_corrupt_file_is_an_empty_store() {
        let missing = temp_path("access-store", "missing/bookmarks.json");
        assert_eq!(BookmarkStore::load_from(&missing), BookmarkStore::default());

        let corrupt = temp_path("access-store", "corrupt/bookmarks.json");
        std::fs::create_dir_all(corrupt.parent().unwrap()).unwrap();
        std::fs::write(&corrupt, "{not json").unwrap();
        assert_eq!(BookmarkStore::load_from(&corrupt), BookmarkStore::default());

        let bad_base64 = temp_path("access-store", "bad-base64/bookmarks.json");
        std::fs::create_dir_all(bad_base64.parent().unwrap()).unwrap();
        std::fs::write(&bad_base64, r#"{"version":1,"recent":[{"path":"/x","name":"x","size":1,"last_accessed":1,"bookmark":"!!"}]}"#).unwrap();
        assert_eq!(
            BookmarkStore::load_from(&bad_base64),
            BookmarkStore::default()
        );
    }

    #[test]
    fn entries_without_a_bookmark_parse_as_none() {
        let store: BookmarkStore = serde_json::from_str(
            r#"{"version":1,"roots":[{"path":"/d","name":"d","added_at":1}],"recent":[{"path":"/d/a.parquet","name":"a.parquet","size":3,"last_accessed":2,"bookmark":null}]}"#,
        )
        .unwrap();
        assert_eq!(store.roots[0].bookmark, None);
        assert_eq!(store.recent[0].bookmark, None);
        assert_eq!(store.bookmark_for("/d"), None);
        assert_eq!(
            store.last_export, None,
            "a store written before last_export existed reads as none"
        );
    }

    #[test]
    fn recent_files_are_newest_first_deduplicated_and_capped() {
        let mut store = BookmarkStore::default();
        let total = MAX_RECENT as i64 + 2;
        for i in 0..total {
            store.upsert_recent(recent(&format!("/f{i}.parquet"), i));
        }
        let paths: Vec<String> = store.recent.iter().map(|r| r.path.clone()).collect();
        let expected: Vec<String> = (2..total).rev().map(|i| format!("/f{i}.parquet")).collect();
        assert_eq!(paths, expected, "the two oldest fell off the end");

        // Re-opening an entry moves it to the front and drops nothing.
        store.upsert_recent(recent("/f3.parquet", 99));
        let paths: Vec<String> = store.recent.iter().map(|r| r.path.clone()).collect();
        let mut expected: Vec<String> = vec!["/f3.parquet".to_string()];
        expected.extend((2..total).rev().filter(|&i| i != 3).map(|i| format!("/f{i}.parquet")));
        assert_eq!(paths, expected);
        assert_eq!(store.recent[0].last_accessed, 99);
        assert_eq!(store.recent.len(), MAX_RECENT);

        let last = format!("/f{}.parquet", total - 1);
        assert!(store.remove_recent(&last));
        assert!(!store.remove_recent(&last));
        store.clear_recent();
        assert!(store.recent.is_empty());
    }

    #[test]
    fn bookmarks_are_looked_up_and_replaced_by_path() {
        let mut store = BookmarkStore::default();
        store.add_root(RootEntry {
            path: "/d".into(),
            name: "d".into(),
            bookmark: Some(vec![1]),
            added_at: 0,
        });
        store.add_root(RootEntry {
            path: "/d".into(),
            name: "d".into(),
            bookmark: Some(vec![2]),
            added_at: 1,
        });
        assert_eq!(
            store.roots.len(),
            1,
            "adding the same root twice keeps one entry"
        );
        store.upsert_recent(recent("/d/a.parquet", 0));

        assert_eq!(store.bookmark_for("/d"), Some(&[2u8][..]));
        assert_eq!(store.bookmark_for("/d/a.parquet"), Some(&[0u8, 255, 7][..]));
        assert_eq!(store.bookmark_for("/elsewhere"), None);

        assert!(store.set_bookmark("/d/a.parquet", vec![9]));
        assert_eq!(store.bookmark_for("/d/a.parquet"), Some(&[9u8][..]));
        assert!(!store.set_bookmark("/elsewhere", vec![9]));

        store.last_export = Some(ExportDirEntry {
            path: "/exports".into(),
            bookmark: None,
            exported_at: 0,
        });
        assert!(store.set_bookmark("/exports", vec![7]));
        assert_eq!(store.last_export.as_ref().unwrap().bookmark, Some(vec![7]));

        assert!(store.remove_root("/d"));
        assert!(!store.remove_root("/d"));
    }

    fn session_tab(path: &str) -> SessionTabEntry {
        SessionTabEntry {
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap().to_string(),
            bookmark: Some(format!("bm:{path}").into_bytes()),
            state: SessionTabState {
                view_mode: Some("query".into()),
                current_page: Some(3),
                active_filter: Some("x > 1".into()),
            },
        }
    }

    #[test]
    fn the_session_round_trips_and_an_older_store_reads_without_one() {
        let file = temp_path("access-store", "session/bookmarks.json");
        let mut store = BookmarkStore::default();
        store.set_session(
            vec![session_tab("/d/a.parquet"), session_tab("/d/b.parquet")],
            Some("/d/b.parquet".into()),
            40,
        );
        store.save_to(&file).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"view_mode\": \"query\""), "{text}");
        assert!(text.contains("\"current_page\": 3"), "{text}");
        assert_eq!(BookmarkStore::load_from(&file), store);

        let older: BookmarkStore =
            serde_json::from_str(r#"{"version":1,"roots":[],"recent":[]}"#).unwrap();
        assert_eq!(older.session, None, "no session to restore, nothing to say");
        assert!(older.session_tabs().is_empty());

        // A tab saved without any state, or by a build that knew fewer
        // fields, reads with the defaults.
        let sparse: BookmarkStore = serde_json::from_str(
            r#"{"version":1,"session":{"tabs":[{"path":"/d/a.parquet","name":"a.parquet"}],"saved_at":1}}"#,
        )
        .unwrap();
        let tabs = sparse.session_tabs();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].bookmark, None);
        assert_eq!(tabs[0].state, SessionTabState::default());
        assert_eq!(sparse.session.as_ref().unwrap().active, None);
    }

    #[test]
    fn set_session_deduplicates_truncates_and_checks_the_active_path() {
        let mut store = BookmarkStore::default();
        let mut tabs: Vec<SessionTabEntry> = (0..MAX_SESSION_TABS + 5)
            .map(|i| session_tab(&format!("/f{i}.parquet")))
            .collect();
        tabs.insert(1, session_tab("/f0.parquet"));
        store.set_session(
            tabs,
            Some(&format!("/f{}.parquet", MAX_SESSION_TABS + 2)).cloned(),
            1,
        );

        let session = store.session.as_ref().unwrap();
        assert_eq!(session.tabs.len(), MAX_SESSION_TABS);
        assert_eq!(session.tabs[0].path, "/f0.parquet");
        assert_eq!(
            session.tabs[1].path, "/f1.parquet",
            "the duplicate is dropped"
        );
        assert_eq!(
            session.tabs.last().unwrap().path,
            format!("/f{}.parquet", MAX_SESSION_TABS - 1)
        );
        assert_eq!(session.active, None, "the active tab fell off the end");

        store.set_session(
            vec![session_tab("/a.parquet")],
            Some("/a.parquet".into()),
            2,
        );
        assert_eq!(
            store.session.as_ref().unwrap().active.as_deref(),
            Some("/a.parquet")
        );
        assert_eq!(store.session.as_ref().unwrap().saved_at, 2);

        store.set_session(Vec::new(), None, 3);
        assert!(
            store.session_tabs().is_empty(),
            "closing every tab saves an empty session"
        );
    }

    #[test]
    fn a_session_tab_bookmark_is_found_and_replaced_after_the_recent_entry() {
        let mut store = BookmarkStore::default();
        store.set_session(vec![session_tab("/d/a.parquet")], None, 0);
        assert_eq!(
            store.bookmark_for("/d/a.parquet"),
            Some(&b"bm:/d/a.parquet"[..])
        );

        store.upsert_recent(recent("/d/a.parquet", 0));
        assert_eq!(
            store.bookmark_for("/d/a.parquet"),
            Some(&[0u8, 255, 7][..]),
            "the recent entry's bookmark comes first"
        );

        assert!(store.set_bookmark("/d/a.parquet", vec![9]));
        assert_eq!(store.session_tabs()[0].bookmark, Some(vec![9]));
        assert_eq!(store.recent[0].bookmark, Some(vec![9]));
    }
}
