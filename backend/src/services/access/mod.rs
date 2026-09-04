//! File access under the App Sandbox.
//!
//! A sandboxed app can read what the user dropped on the window or picked in
//! a dialog, but only until it quits. To reopen a workspace folder or a
//! recent file on the next launch it needs a *security-scoped bookmark*
//! created while it still had access, and it must call
//! `startAccessingSecurityScopedResource` on the resolved URL before reading
//! (and `stopAccessing…` when done — the kernel caps how many such grants a
//! process holds).
//!
//! `FileAccess` owns both halves: the persisted bookmarks
//! ([`store::BookmarkStore`], `bookmarks.json` in the app data directory) and
//! the grants currently held, one per path. The platform calls sit behind
//! [`BookmarkProvider`] so the store and the lifecycle are tested with a fake
//! on any OS; `macos::MacBookmarks` is the only real implementation and
//! [`NoopBookmarks`] serves every other platform, the e2e bridge and
//! `pnpm tauri dev` (which is not sandboxed anyway).
//!
//! Lifecycle: `ParquetCache` calls [`FileAccess::acquire`] before it fills an
//! entry and [`FileAccess::release`] when it evicts one, so a file's grant
//! lives exactly as long as its cache entry — DataFusion reopens the file on
//! every query, so the grant has to outlive the first read. Workspace roots
//! hold their grant from `add_root` (or from launch, once restored) until
//! `remove_root`.

#[cfg(target_os = "macos")]
pub mod macos;
pub mod store;

use crate::models::{RecentFile, WorkspaceRoot};
use std::any::Any;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use store::{BookmarkStore, RecentEntry, RootEntry};

/// The platform's security-scoped bookmark primitives.
pub trait BookmarkProvider: Send + Sync {
    /// Turn access the app holds right now (a dropped file, a dialog pick,
    /// something inside an open root, a resolved bookmark) into bytes that
    /// grant it again after a relaunch. `None` means the platform has no
    /// such thing; the path alone is recorded.
    fn create(&self, path: &Path) -> Result<Option<Vec<u8>>, String>;
    /// Resolve the bytes back into a path and start accessing it. The
    /// returned token ends the access when dropped.
    fn resolve(&self, bookmark: &[u8]) -> Result<Resolved, String>;
}

/// A resolved bookmark: where the item is now, whether the bookmark should be
/// re-created (the item moved), and the grant that keeps it readable.
pub struct Resolved {
    pub path: PathBuf,
    pub stale: bool,
    pub token: AccessToken,
}

/// An open security-scoped grant; dropping it calls `stopAccessing…`. Opaque
/// so the store never depends on a platform type.
pub struct AccessToken {
    _guard: Option<Box<dyn Any + Send + Sync>>,
}

impl AccessToken {
    pub fn none() -> Self {
        Self { _guard: None }
    }

    pub fn new<T: Any + Send + Sync>(guard: T) -> Self {
        Self { _guard: Some(Box::new(guard)) }
    }
}

/// No bookmarks: paths are recorded bare and assumed readable. Every
/// platform but macOS, the e2e bridge, and the unit tests that do not care.
pub struct NoopBookmarks;

impl BookmarkProvider for NoopBookmarks {
    fn create(&self, _path: &Path) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }

    fn resolve(&self, bookmark: &[u8]) -> Result<Resolved, String> {
        let path = std::str::from_utf8(bookmark).map_err(|e| e.to_string())?;
        Ok(Resolved {
            path: PathBuf::from(path),
            stale: false,
            token: AccessToken::none(),
        })
    }
}

struct State {
    store: BookmarkStore,
    /// The grants currently held, by the path they were requested for.
    held: HashMap<String, AccessToken>,
}

pub struct FileAccess {
    provider: Box<dyn BookmarkProvider>,
    /// Where the store is written; `None` keeps it in memory (tests).
    store_path: Option<PathBuf>,
    state: Mutex<State>,
}

/// Unix time in milliseconds.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.to_string())
}

impl FileAccess {
    /// Load the store from `dir/bookmarks.json` (or start empty when `dir`
    /// is `None`) and re-acquire every workspace root. A root whose bookmark
    /// no longer resolves is dropped: the folder is gone, and the user can
    /// open it again in one click.
    pub fn load(provider: Box<dyn BookmarkProvider>, dir: Option<&Path>) -> Self {
        let store_path = dir.map(|d| d.join("bookmarks.json"));
        let store = store_path
            .as_deref()
            .map(BookmarkStore::load_from)
            .unwrap_or_default();
        let access = Self {
            provider,
            store_path,
            state: Mutex::new(State {
                store,
                held: HashMap::new(),
            }),
        };
        access.restore_roots();
        access
    }

    /// No bookmarks, nothing persisted: `ParquetCache::new()`, the bridge
    /// when it has no data directory, and tests.
    pub fn disabled() -> Self {
        Self::load(Box::new(NoopBookmarks), None)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, String> {
        self.state.lock().map_err(|e| e.to_string())
    }

    fn save(&self, state: &State) -> Result<(), String> {
        match &self.store_path {
            Some(path) => state.store.save_to(path),
            None => Ok(()),
        }
    }

    fn save_or_log(&self, state: &State) {
        if let Err(e) = self.save(state) {
            eprintln!("could not save bookmarks: {e}");
        }
    }

    /// Resolve the bookmark recorded for `path`, if there is one, refreshing
    /// it in the store when the platform reports it stale. `Ok(None)` means
    /// nothing is recorded, so the path is readable or not on its own.
    fn resolve_recorded(&self, state: &mut State, path: &str) -> Result<Option<Resolved>, String> {
        let Some(bookmark) = state.store.bookmark_for(path).map(<[u8]>::to_vec) else {
            return Ok(None);
        };
        let resolved = self.provider.resolve(&bookmark)?;
        if resolved.stale {
            match self.provider.create(&resolved.path) {
                Ok(Some(fresh)) => {
                    if state.store.set_bookmark(path, fresh) {
                        self.save_or_log(state);
                    }
                }
                Ok(None) => {}
                Err(e) => eprintln!("could not refresh the stale bookmark for {path}: {e}"),
            }
        }
        Ok(Some(resolved))
    }

    fn restore_roots(&self) {
        let Ok(mut state) = self.lock() else { return };
        let paths: Vec<String> = state.store.roots.iter().map(|r| r.path.clone()).collect();
        let mut changed = false;
        for path in paths {
            match self.resolve_recorded(&mut state, &path) {
                Ok(Some(resolved)) if resolved.path == Path::new(&path) => {
                    state.held.insert(path, resolved.token);
                }
                Ok(Some(resolved)) => {
                    eprintln!(
                        "workspace root {path} now resolves to {}; dropping it",
                        resolved.path.display()
                    );
                    state.store.remove_root(&path);
                    changed = true;
                }
                Ok(None) => {
                    if !Path::new(&path).is_dir() {
                        state.store.remove_root(&path);
                        changed = true;
                    }
                }
                Err(e) => {
                    eprintln!("workspace root {path} is no longer available ({e}); dropping it");
                    state.store.remove_root(&path);
                    changed = true;
                }
            }
        }
        if changed {
            self.save_or_log(&state);
        }
    }

    /// Make `path` readable for as long as the grant is held. A path with no
    /// recorded bookmark is left alone: it was dropped or picked in this
    /// session and is readable already, or it is not and the read will say
    /// so. A bookmark that no longer resolves is logged, not an error, for
    /// the same reason. Idempotent.
    pub fn acquire(&self, path: &str) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.held.contains_key(path) {
            return Ok(());
        }
        match self.resolve_recorded(&mut state, path) {
            Ok(Some(resolved)) => {
                if resolved.path != Path::new(path) {
                    eprintln!(
                        "bookmark for {path} now resolves to {}",
                        resolved.path.display()
                    );
                }
                state.held.insert(path.to_string(), resolved.token);
            }
            Ok(None) => {}
            Err(e) => eprintln!("bookmark for {path} could not be resolved: {e}"),
        }
        Ok(())
    }

    /// Drop the grant for `path`, if held.
    pub fn release(&self, path: &str) {
        if let Ok(mut state) = self.lock() {
            state.held.remove(path);
        }
    }

    /// Whether `path` exists, resolving its bookmark for the duration of
    /// the check when one is recorded and not held.
    pub fn file_exists(&self, path: &str) -> bool {
        let Ok(mut state) = self.lock() else {
            return false;
        };
        if state.held.contains_key(path) || state.store.bookmark_for(path).is_none() {
            return Path::new(path).exists();
        }
        match self.resolve_recorded(&mut state, path) {
            Ok(Some(resolved)) => resolved.path == Path::new(path) && resolved.path.exists(),
            Ok(None) => Path::new(path).exists(),
            Err(_) => false,
        }
    }

    /// Record a file the user just opened so Recent Files can reopen it after
    /// a relaunch: create its bookmark now, while the app can read it, put it
    /// at the front of the list and hold its grant if none is held yet (the
    /// file may have been reached through a workspace root the user can
    /// close before the tab).
    pub fn remember_file(&self, path: &str) -> Result<RecentFile, String> {
        let size = std::fs::metadata(path)
            .map_err(|e| format!("could not read {path}: {e}"))?
            .len();
        let bookmark = match self.provider.create(Path::new(path)) {
            Ok(bookmark) => bookmark,
            Err(e) => {
                eprintln!("could not create a bookmark for {path}: {e}");
                None
            }
        };
        let entry = RecentEntry {
            path: path.to_string(),
            name: display_name(path),
            size,
            last_accessed: now_ms(),
            bookmark,
        };
        let recent = RecentFile {
            path: entry.path.clone(),
            name: entry.name.clone(),
            size,
            last_accessed: entry.last_accessed,
            available: true,
        };
        let mut state = self.lock()?;
        state.store.upsert_recent(entry);
        if !state.held.contains_key(path) {
            match self.resolve_recorded(&mut state, path) {
                Ok(Some(resolved)) => {
                    state.held.insert(path.to_string(), resolved.token);
                }
                Ok(None) => {}
                Err(e) => eprintln!("the new bookmark for {path} does not resolve: {e}"),
            }
        }
        self.save(&state)?;
        Ok(recent)
    }

    /// Recent Files, newest first, each probed for availability.
    pub fn recent_files(&self) -> Vec<RecentFile> {
        let Ok(mut state) = self.lock() else {
            return Vec::new();
        };
        let entries = state.store.recent.clone();
        entries
            .into_iter()
            .map(|entry| {
                let available = if state.held.contains_key(&entry.path) {
                    Path::new(&entry.path).exists()
                } else {
                    match self.resolve_recorded(&mut state, &entry.path) {
                        Ok(Some(resolved)) => {
                            resolved.path == Path::new(&entry.path) && resolved.path.exists()
                        }
                        Ok(None) => Path::new(&entry.path).exists(),
                        Err(_) => false,
                    }
                };
                RecentFile {
                    path: entry.path,
                    name: entry.name,
                    size: entry.size,
                    last_accessed: entry.last_accessed,
                    available,
                }
            })
            .collect()
    }

    pub fn forget_file(&self, path: &str) {
        if let Ok(mut state) = self.lock() {
            if state.store.remove_recent(path) {
                self.save_or_log(&state);
            }
        }
    }

    pub fn clear_recent(&self) {
        if let Ok(mut state) = self.lock() {
            state.store.clear_recent();
            self.save_or_log(&state);
        }
    }

    /// Open `path` as a workspace root: bookmark it, hold its grant until
    /// `remove_root`, and persist it. `path` must be a directory the app can
    /// read now (the folder dialog grants that).
    pub fn add_root(&self, path: &str) -> Result<WorkspaceRoot, String> {
        if !Path::new(path).is_dir() {
            return Err(format!("{path} is not a directory"));
        }
        let bookmark = self.provider.create(Path::new(path))?;
        let root = WorkspaceRoot {
            path: path.to_string(),
            name: display_name(path),
        };
        let mut state = self.lock()?;
        state.store.add_root(RootEntry {
            path: root.path.clone(),
            name: root.name.clone(),
            bookmark,
            added_at: now_ms(),
        });
        if !state.held.contains_key(path) {
            match self.resolve_recorded(&mut state, path) {
                Ok(Some(resolved)) => {
                    state.held.insert(path.to_string(), resolved.token);
                }
                Ok(None) => {}
                Err(e) => eprintln!("the new bookmark for {path} does not resolve: {e}"),
            }
        }
        self.save(&state)?;
        Ok(root)
    }

    pub fn remove_root(&self, path: &str) {
        if let Ok(mut state) = self.lock() {
            state.held.remove(path);
            if state.store.remove_root(path) {
                self.save_or_log(&state);
            }
        }
    }

    pub fn roots(&self) -> Vec<WorkspaceRoot> {
        self.lock()
            .map(|state| {
                state
                    .store
                    .roots
                    .iter()
                    .map(|r| WorkspaceRoot {
                        path: r.path.clone(),
                        name: r.name.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
pub mod fake {
    //! A bookmark provider whose grants can be counted and revoked.
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    #[derive(Default)]
    pub struct FakeState {
        /// Paths whose grant is open right now.
        pub active: HashSet<String>,
        pub starts: usize,
        pub stops: usize,
        /// Every path a bookmark was created for, in order.
        pub created: Vec<String>,
        /// Bookmarks for these paths fail to resolve (the item was deleted).
        pub revoked: HashSet<String>,
        /// Bookmarks for these paths resolve but report themselves stale.
        pub stale: HashSet<String>,
    }

    #[derive(Clone, Default)]
    pub struct FakeBookmarks(pub Arc<Mutex<FakeState>>);

    struct FakeToken(Arc<Mutex<FakeState>>, String);

    impl Drop for FakeToken {
        fn drop(&mut self) {
            let mut state = self.0.lock().unwrap();
            state.stops += 1;
            state.active.remove(&self.1);
        }
    }

    impl BookmarkProvider for FakeBookmarks {
        fn create(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
            let path = path.to_string_lossy().into_owned();
            self.0.lock().unwrap().created.push(path.clone());
            Ok(Some(format!("bm:{path}").into_bytes()))
        }

        fn resolve(&self, bookmark: &[u8]) -> Result<Resolved, String> {
            let text = std::str::from_utf8(bookmark).map_err(|e| e.to_string())?;
            let path = text
                .strip_prefix("bm:")
                .ok_or("not a fake bookmark")?
                .to_string();
            let mut state = self.0.lock().unwrap();
            if state.revoked.contains(&path) {
                return Err(format!("{path} could not be resolved"));
            }
            state.starts += 1;
            state.active.insert(path.clone());
            let stale = state.stale.contains(&path);
            drop(state);
            Ok(Resolved {
                path: PathBuf::from(&path),
                stale,
                token: AccessToken::new(FakeToken(self.0.clone(), path)),
            })
        }
    }

    impl FakeBookmarks {
        pub fn active(&self) -> Vec<String> {
            let mut v: Vec<String> = self.0.lock().unwrap().active.iter().cloned().collect();
            v.sort();
            v
        }
        pub fn starts(&self) -> usize {
            self.0.lock().unwrap().starts
        }
        pub fn stops(&self) -> usize {
            self.0.lock().unwrap().stops
        }
        pub fn created(&self) -> Vec<String> {
            self.0.lock().unwrap().created.clone()
        }
        pub fn revoke(&self, path: &str) {
            self.0.lock().unwrap().revoked.insert(path.to_string());
        }
        pub fn mark_stale(&self, path: &str) {
            self.0.lock().unwrap().stale.insert(path.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeBookmarks;
    use super::*;
    use crate::services::test_support::temp_path;

    fn fixture(name: &str) -> (PathBuf, String) {
        let dir = temp_path("access", name);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let file = dir.join("data").join("a.parquet");
        std::fs::write(&file, b"parquet").unwrap();
        (dir, file.to_string_lossy().into_owned())
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_remembered_file_is_bookmarked_held_and_listed() {
        let (dir, file) = fixture("remember");
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));

        let recent = access.remember_file(&file).unwrap();
        assert_eq!(recent.name, "a.parquet");
        assert_eq!(recent.size, 7);
        assert!(recent.available);
        assert_eq!(fake.created(), [file.clone()]);
        assert_eq!(
            fake.active(),
            [file.clone()],
            "the grant is held from the new bookmark"
        );

        let listed = access.recent_files();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, file);
        assert!(listed[0].available);
        assert_eq!(
            fake.starts(),
            1,
            "a held path is not resolved again to probe it"
        );

        access.release(&file);
        assert!(fake.active().is_empty());
        assert_eq!(fake.stops(), 1);
    }

    #[test]
    fn acquire_resolves_the_bookmark_once_across_a_relaunch() {
        let (dir, file) = fixture("relaunch");
        let first = FakeBookmarks::default();
        let launch = FileAccess::load(Box::new(first.clone()), Some(&dir));
        launch.remember_file(&file).unwrap();
        assert_eq!(first.active(), [file.clone()]);
        // The first launch's grants end with the process.
        drop(launch);
        assert!(first.active().is_empty());

        let second = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(second.clone()), Some(&dir));
        assert_eq!(
            access.recent_files().len(),
            1,
            "the list survived the relaunch"
        );
        access.acquire(&file).unwrap();
        access.acquire(&file).unwrap();
        assert_eq!(
            second.starts(),
            2,
            "one probe from the listing, one held grant"
        );
        assert_eq!(second.active(), [file.clone()]);
        assert!(access.file_exists(&file));
        assert_eq!(
            second.starts(),
            2,
            "a held path is checked without resolving again"
        );

        access.release(&file);
        assert!(second.active().is_empty());
        assert_eq!(second.stops(), second.starts());
    }

    #[test]
    fn a_path_without_a_bookmark_is_left_to_the_filesystem() {
        let (dir, file) = fixture("no-bookmark");
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.acquire(&file).unwrap();
        assert!(fake.active().is_empty());
        assert!(access.file_exists(&file));
        assert!(!access.file_exists(&format!("{file}.missing")));
        assert_eq!(fake.starts(), 0);
    }

    #[test]
    fn a_stale_bookmark_is_recreated_and_saved() {
        let (dir, file) = fixture("stale");
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.remember_file(&file).unwrap();
        access.release(&file);

        fake.mark_stale(&file);
        access.acquire(&file).unwrap();
        assert_eq!(
            fake.created(),
            [file.clone(), file.clone()],
            "re-created from the resolved URL"
        );
        assert_eq!(fake.active(), [file.clone()]);

        let saved = BookmarkStore::load_from(&dir.join("bookmarks.json"));
        assert_eq!(saved.recent.len(), 1);
    }

    #[test]
    fn an_unresolvable_recent_file_is_listed_as_unavailable_and_a_missing_one_too() {
        let (dir, file) = fixture("revoked");
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.remember_file(&file).unwrap();
        access.release(&file);

        fake.revoke(&file);
        let listed = access.recent_files();
        assert_eq!(
            listed.len(),
            1,
            "kept so the user sees it greyed out and can remove it"
        );
        assert!(!listed[0].available);
        assert!(!access.file_exists(&file));
        access.acquire(&file).unwrap();
        assert!(fake.active().is_empty(), "a failed resolve holds nothing");

        // The bookmark resolves again but the file itself is gone.
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        std::fs::remove_file(&file).unwrap();
        assert!(!access.recent_files()[0].available);
        assert!(!access.file_exists(&file));
        assert_eq!(fake.stops(), fake.starts(), "probes drop their grant");

        access.forget_file(&file);
        assert!(access.recent_files().is_empty());
        assert!(BookmarkStore::load_from(&dir.join("bookmarks.json"))
            .recent
            .is_empty());
    }

    #[test]
    fn roots_are_held_until_removed_and_restored_on_launch() {
        let (dir, _file) = fixture("roots");
        let data = s(&dir.join("data"));
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));

        let root = access.add_root(&data).unwrap();
        assert_eq!(
            root,
            WorkspaceRoot {
                path: data.clone(),
                name: "data".into()
            }
        );
        assert_eq!(access.roots(), [root.clone()]);
        assert_eq!(fake.active(), [data.clone()]);
        assert!(access.add_root(&s(&dir.join("nope"))).is_err());

        let relaunch = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(relaunch.clone()), Some(&dir));
        assert_eq!(access.roots(), [root]);
        assert_eq!(
            relaunch.active(),
            [data.clone()],
            "restored roots hold their grant from launch"
        );

        access.remove_root(&data);
        assert!(access.roots().is_empty());
        assert!(relaunch.active().is_empty());
        assert!(BookmarkStore::load_from(&dir.join("bookmarks.json"))
            .roots
            .is_empty());
    }

    #[test]
    fn a_root_whose_bookmark_is_dead_is_dropped_on_launch() {
        let (dir, _file) = fixture("dead-root");
        let data = s(&dir.join("data"));
        let fake = FakeBookmarks::default();
        FileAccess::load(Box::new(fake.clone()), Some(&dir))
            .add_root(&data)
            .unwrap();

        let relaunch = FakeBookmarks::default();
        relaunch.revoke(&data);
        let access = FileAccess::load(Box::new(relaunch.clone()), Some(&dir));
        assert!(access.roots().is_empty());
        assert!(
            BookmarkStore::load_from(&dir.join("bookmarks.json"))
                .roots
                .is_empty(),
            "pruned on disk too"
        );
    }

    #[test]
    fn without_bookmarks_a_deleted_root_is_dropped_on_launch() {
        let (dir, _file) = fixture("noop-root");
        let data = s(&dir.join("data"));
        FileAccess::load(Box::new(NoopBookmarks), Some(&dir))
            .add_root(&data)
            .unwrap();
        std::fs::remove_dir_all(&data).unwrap();
        assert!(FileAccess::load(Box::new(NoopBookmarks), Some(&dir))
            .roots()
            .is_empty());
    }

    #[test]
    fn a_corrupt_store_starts_empty_and_is_overwritten_on_the_next_change() {
        let (dir, file) = fixture("corrupt");
        std::fs::write(dir.join("bookmarks.json"), "{not json").unwrap();
        let access = FileAccess::load(Box::new(NoopBookmarks), Some(&dir));
        assert!(access.recent_files().is_empty());
        access.remember_file(&file).unwrap();
        assert_eq!(
            BookmarkStore::load_from(&dir.join("bookmarks.json"))
                .recent
                .len(),
            1
        );
    }

    #[test]
    fn disabled_access_records_nothing_on_disk() {
        let (_dir, file) = fixture("disabled");
        let access = FileAccess::disabled();
        access.remember_file(&file).unwrap();
        assert_eq!(access.recent_files().len(), 1);
        access.clear_recent();
        assert!(access.recent_files().is_empty());
    }
}
