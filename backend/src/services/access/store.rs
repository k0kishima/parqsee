//! The on-disk record of what the user opened — workspace roots and recent
//! files — each with the security-scoped bookmark that reopens it on the next
//! launch. Pure data: no ObjC, so it is tested on any platform.
//!
//! Lives as `bookmarks.json` in the app data directory. Nothing in here
//! depends on the bundle identifier (the directory is resolved at run time
//! and the entries are keyed by path), so a change of identifier only moves
//! the file, it does not invalidate the format.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::path::Path;

/// How many recent files are kept, newest first.
pub const MAX_RECENT: usize = 5;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookmarkStore {
    pub version: u32,
    #[serde(default)]
    pub roots: Vec<RootEntry>,
    #[serde(default)]
    pub recent: Vec<RecentEntry>,
}

impl Default for BookmarkStore {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            roots: Vec::new(),
            recent: Vec::new(),
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

    /// The bookmark recorded for `path`, whether it is a root or a recent file.
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
    }

    #[test]
    fn recent_files_are_newest_first_deduplicated_and_capped() {
        let mut store = BookmarkStore::default();
        for i in 0..7 {
            store.upsert_recent(recent(&format!("/f{i}.parquet"), i));
        }
        let paths: Vec<&str> = store.recent.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "/f6.parquet",
                "/f5.parquet",
                "/f4.parquet",
                "/f3.parquet",
                "/f2.parquet"
            ]
        );

        store.upsert_recent(recent("/f3.parquet", 99));
        let paths: Vec<&str> = store.recent.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "/f3.parquet",
                "/f6.parquet",
                "/f5.parquet",
                "/f4.parquet",
                "/f2.parquet"
            ]
        );
        assert_eq!(store.recent[0].last_accessed, 99);

        assert!(store.remove_recent("/f6.parquet"));
        assert!(!store.remove_recent("/f6.parquet"));
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

        assert!(store.remove_root("/d"));
        assert!(!store.remove_root("/d"));
    }
}
