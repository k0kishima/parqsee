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
//! `remove_root`. The last export folder is different: it is only ever
//! resolved to tell the save panel where to start, and its grant ends
//! within that call — the panel itself grants the write.
//!
//! The tabs of the last session ([`FileAccess::save_session`],
//! [`FileAccess::session_tabs`]) add no lifecycle of their own: a restored
//! tab is reopened through `ParquetCache` like any other, and `acquire`
//! finds the tab's bookmark in the store when Recent Files no longer holds
//! one for it.

#[cfg(target_os = "macos")]
pub mod macos;
pub mod store;

use crate::models::{RecentFile, SessionTab, SessionTabState, SessionTabs, WorkspaceRoot};
use std::any::Any;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use store::{BookmarkStore, ExportDirEntry, RecentEntry, RootEntry, SessionTabEntry};

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
        self.resolve_bookmark(state, path, &bookmark).map(Some)
    }

    /// Resolve `bookmark`, recorded in the store under `path`, re-creating
    /// it there when the platform reports it stale.
    fn resolve_bookmark(
        &self,
        state: &mut State,
        path: &str,
        bookmark: &[u8],
    ) -> Result<Resolved, String> {
        let resolved = self.provider.resolve(bookmark)?;
        if resolved.stale {
            self.refresh_stale(state, path, &resolved.path);
        }
        Ok(resolved)
    }

    /// Re-create the bookmark recorded under `path` from where the item is
    /// now (`at`), and save. Best effort: a failure keeps the stale one,
    /// which still resolved.
    fn refresh_stale(&self, state: &mut State, path: &str, at: &Path) {
        match self.provider.create(at) {
            Ok(Some(fresh)) => {
                if state.store.set_bookmark(path, fresh) {
                    self.save_or_log(state);
                }
            }
            Ok(None) => {}
            Err(e) => eprintln!("could not refresh the stale bookmark for {path}: {e}"),
        }
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
        self.probe(path)
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

    /// Whether the file at `path` can be reached: its bookmark, when one is
    /// recorded and not held, must resolve to the same path, and the file
    /// must exist. Under the sandbox `exists` alone says nothing — `stat`
    /// succeeds on paths the app cannot open — so the bookmark decides. A
    /// grant taken for the probe ends with it.
    ///
    /// The bookmark is resolved with the state unlocked. Resolving is a
    /// platform call that can take long — a volume that is gone, a network
    /// share that is not mounted any more — and a listing that probes
    /// twenty entries must not keep the opens and the session restore
    /// waiting on the same lock while it does. The lock is taken twice
    /// instead: once to read what is recorded, once more only if the stale
    /// bookmark is to be refreshed.
    fn probe(&self, path: &str) -> bool {
        let bookmark = {
            let Ok(state) = self.lock() else {
                return false;
            };
            if state.held.contains_key(path) {
                return Path::new(path).exists();
            }
            match state.store.bookmark_for(path) {
                Some(bookmark) => bookmark.to_vec(),
                None => return Path::new(path).exists(),
            }
        };
        match self.provider.resolve(&bookmark) {
            Ok(resolved) => {
                if resolved.stale {
                    if let Ok(mut state) = self.lock() {
                        self.refresh_stale(&mut state, path, &resolved.path);
                    }
                }
                resolved.path == Path::new(path) && resolved.path.exists()
            }
            Err(_) => false,
        }
    }

    /// Recent Files, newest first, each probed for availability. The list
    /// is copied out under the lock; the probes run without it.
    pub fn recent_files(&self) -> Vec<RecentFile> {
        let entries = match self.lock() {
            Ok(state) => state.store.recent.clone(),
            Err(_) => return Vec::new(),
        };
        entries
            .into_iter()
            .map(|entry| RecentFile {
                available: self.probe(&entry.path),
                path: entry.path,
                name: entry.name,
                size: entry.size,
                last_accessed: entry.last_accessed,
            })
            .collect()
    }

    /// Recent Files as recorded — path and name, newest first — with no
    /// probe: what the File › Open Recent menu lists (see `crate::menu`).
    pub fn recent_entries(&self) -> Vec<(String, String)> {
        self.lock()
            .map(|state| {
                state
                    .store
                    .recent
                    .iter()
                    .map(|r| (r.path.clone(), r.name.clone()))
                    .collect()
            })
            .unwrap_or_default()
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

    /// Record the folder an export was just written to, so the next save
    /// panel can start there. Its bookmark is best effort: the panel granted
    /// the file, not the folder, so creation fails under the sandbox unless
    /// the folder is readable anyway (inside an open root, say) — the bare
    /// path is kept then, which is all the panel needs.
    pub fn remember_export(&self, export_path: &str) {
        let Some(dir) = Path::new(export_path)
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
        else {
            return;
        };
        let bookmark = match self.provider.create(dir) {
            Ok(bookmark) => bookmark,
            Err(e) => {
                eprintln!("no bookmark for the export folder {}: {e}", dir.display());
                None
            }
        };
        if let Ok(mut state) = self.lock() {
            state.store.last_export = Some(ExportDirEntry {
                path: dir.to_string_lossy().into_owned(),
                bookmark,
                exported_at: now_ms(),
            });
            self.save_or_log(&state);
        }
    }

    /// Where the save panel for an export of `source_path` should start:
    /// the file's own folder when it lies inside an open workspace root,
    /// else the folder of the last export, else nowhere in particular. A
    /// folder that no longer exists is skipped. The last export's bookmark
    /// is resolved only for the path; no grant outlives this call.
    pub fn export_default_dir(&self, source_path: &str) -> Option<String> {
        let mut state = self.lock().ok()?;
        let source_dir = Path::new(source_path).parent()?;
        let in_root = state
            .store
            .roots
            .iter()
            .any(|root| source_dir.starts_with(&root.path));
        if in_root && source_dir.is_dir() {
            return Some(source_dir.to_string_lossy().into_owned());
        }
        let entry = state.store.last_export.clone()?;
        let dir = match &entry.bookmark {
            Some(bookmark) => match self.resolve_bookmark(&mut state, &entry.path, bookmark) {
                Ok(resolved) => {
                    let is_dir = resolved.path.is_dir();
                    // `resolved.token` ends the grant here.
                    is_dir.then_some(resolved.path)
                }
                Err(e) => {
                    eprintln!("the last export folder {} does not resolve: {e}", entry.path);
                    Some(PathBuf::from(&entry.path))
                }
            },
            None => Some(PathBuf::from(&entry.path)),
        }?;
        dir.is_dir().then(|| dir.to_string_lossy().into_owned())
    }

    /// Record the open tabs, in order, and the active one, replacing the
    /// last session. Each tab keeps a bookmark of its own so it reopens even
    /// once Recent Files has forgotten the file — but never a second one
    /// created for the same file: the bytes come from the recent entry, or
    /// from the tab's previous session entry, and only a file recorded
    /// nowhere gets one created (it is readable now, being open).
    pub fn save_session(
        &self,
        tabs: Vec<(String, SessionTabState)>,
        active: Option<String>,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let entries = tabs
            .into_iter()
            .map(|(path, tab_state)| {
                let bookmark = match state.store.bookmark_for(&path) {
                    Some(bytes) => Some(bytes.to_vec()),
                    None => match self.provider.create(Path::new(&path)) {
                        Ok(bookmark) => bookmark,
                        Err(e) => {
                            eprintln!("could not create a bookmark for the tab {path}: {e}");
                            None
                        }
                    },
                };
                SessionTabEntry {
                    name: display_name(&path),
                    path,
                    bookmark,
                    state: tab_state,
                }
            })
            .collect();
        state.store.set_session(entries, active, now_ms());
        self.save(&state)
    }

    /// The tabs of the last session, each probed for availability the way
    /// Recent Files are; the webview reopens the available ones and names
    /// the rest. The store is left as it is — the next `save_session`, once
    /// the tabs are open again, is what drops the missing ones.
    pub fn session_tabs(&self) -> SessionTabs {
        // Copied out under the lock; the probes run without it (see `probe`).
        let session = self.lock().ok().and_then(|state| state.store.session.clone());
        let Some(session) = session else {
            return SessionTabs {
                tabs: Vec::new(),
                active: None,
            };
        };
        let tabs = session
            .tabs
            .into_iter()
            .map(|entry| SessionTab {
                available: self.probe(&entry.path),
                path: entry.path,
                name: entry.name,
                state: entry.state,
            })
            .collect();
        SessionTabs {
            tabs,
            active: session.active,
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
        /// Bookmarks for these paths cannot be created (no access to them).
        pub uncreatable: HashSet<String>,
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
            let mut state = self.0.lock().unwrap();
            if state.uncreatable.contains(&path) {
                return Err(format!("no access to {path}"));
            }
            state.created.push(path.clone());
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
        pub fn make_uncreatable(&self, path: &str) {
            self.0.lock().unwrap().uncreatable.insert(path.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeBookmarks;
    use super::*;
    use crate::services::test_support::temp_path;
    use std::sync::{Arc, Condvar};
    use std::time::Duration;

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
        assert_eq!(fake.created(), std::slice::from_ref(&file));
        assert_eq!(
            fake.active(),
            std::slice::from_ref(&file),
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
        assert_eq!(first.active(), std::slice::from_ref(&file));
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
        assert_eq!(second.active(), std::slice::from_ref(&file));
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
        assert_eq!(fake.active(), std::slice::from_ref(&file));

        let saved = BookmarkStore::load_from(&dir.join("bookmarks.json"));
        assert_eq!(saved.recent.len(), 1);
    }

    /// `FakeBookmarks` whose `resolve` waits at a gate the test opens,
    /// standing in for a bookmark that takes long to resolve.
    struct GatedBookmarks {
        inner: FakeBookmarks,
        gate: Arc<(Mutex<bool>, Condvar)>,
        /// Signalled when a resolve has reached the gate.
        entered: std::sync::mpsc::Sender<()>,
    }

    impl BookmarkProvider for GatedBookmarks {
        fn create(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
            self.inner.create(path)
        }

        fn resolve(&self, bookmark: &[u8]) -> Result<Resolved, String> {
            let _ = self.entered.send(());
            let (open, woken) = &*self.gate;
            let mut open = open.lock().unwrap();
            while !*open {
                open = woken.wait(open).unwrap();
            }
            self.inner.resolve(bookmark)
        }
    }

    #[test]
    fn a_listing_does_not_hold_the_lock_while_a_bookmark_resolves() {
        let (dir, file) = fixture("slow-resolve");
        let other = s(&dir.join("data").join("b.parquet"));
        std::fs::write(&other, b"parquet").unwrap();
        let fake = FakeBookmarks::default();
        let gate = Arc::new((Mutex::new(true), Condvar::new()));
        let (entered, reached) = std::sync::mpsc::channel();
        let access = Arc::new(FileAccess::load(
            Box::new(GatedBookmarks {
                inner: fake.clone(),
                gate: Arc::clone(&gate),
                entered,
            }),
            Some(&dir),
        ));
        access.remember_file(&file).unwrap();
        access.release(&file);
        let _ = reached.try_recv();

        // Close the gate: the listing's probe of `file` now blocks inside resolve.
        *gate.0.lock().unwrap() = false;
        let listing = {
            let access = Arc::clone(&access);
            std::thread::spawn(move || access.recent_files())
        };
        reached
            .recv_timeout(Duration::from_secs(5))
            .expect("the listing reached the resolve");

        // Meanwhile the existence check before an open (a file with no
        // bookmark: dropped or picked this session) needs the lock too, and
        // must not wait for the listing.
        let (done, finished) = std::sync::mpsc::channel();
        {
            let access = Arc::clone(&access);
            let other = other.clone();
            std::thread::spawn(move || {
                let _ = done.send((access.file_exists(&other), access.roots().len()));
            });
        }
        let checked = finished
            .recv_timeout(Duration::from_secs(5))
            .expect("file_exists finished while the listing was resolving");
        assert_eq!(checked, (true, 0));

        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        let listed = listing.join().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].available);
        assert_eq!(fake.stops(), fake.starts(), "the probe dropped its grant");
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

        assert_eq!(
            access.recent_entries(),
            [(file.clone(), "a.parquet".to_string())],
            "listed as recorded, without a probe"
        );
        assert_eq!(fake.starts(), fake.stops());
        access.forget_file(&file);
        assert!(access.recent_files().is_empty());
        assert!(access.recent_entries().is_empty());
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
        assert_eq!(access.roots(), std::slice::from_ref(&root));
        assert_eq!(fake.active(), std::slice::from_ref(&data));
        assert!(access.add_root(&s(&dir.join("nope"))).is_err());

        let relaunch = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(relaunch.clone()), Some(&dir));
        assert_eq!(access.roots(), [root]);
        assert_eq!(
            relaunch.active(),
            std::slice::from_ref(&data),
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
    fn export_default_dir_prefers_the_source_folder_inside_a_root() {
        let (dir, file) = fixture("export-in-root");
        let data = s(&dir.join("data"));
        std::fs::create_dir_all(dir.join("data/sub")).unwrap();
        std::fs::create_dir_all(dir.join("out")).unwrap();
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.add_root(&data).unwrap();
        access.remember_export(&s(&dir.join("out/x.csv")));

        assert_eq!(access.export_default_dir(&file), Some(data.clone()));
        assert_eq!(
            access.export_default_dir(&s(&dir.join("data/sub/b.parquet"))),
            Some(s(&dir.join("data/sub"))),
            "a subfolder of the root counts"
        );
        assert_eq!(
            access.export_default_dir(&s(&dir.join("elsewhere/c.parquet"))),
            Some(s(&dir.join("out"))),
            "outside every root, the last export folder"
        );
        assert_eq!(
            fake.active(),
            std::slice::from_ref(&data),
            "only the root's grant is held"
        );
    }

    #[test]
    fn export_default_dir_falls_back_to_the_last_export_folder_then_to_none() {
        let (dir, file) = fixture("export-fallback");
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));

        assert_eq!(access.export_default_dir(&file), None, "nothing to go on");
        access.remember_export(&s(&out.join("x.csv")));
        assert_eq!(access.export_default_dir(&file), Some(s(&out)));
        assert!(fake.active().is_empty(), "the grant does not outlive the call");
        assert_eq!(fake.starts(), 1);
        assert_eq!(fake.stops(), 1);

        std::fs::remove_dir_all(&out).unwrap();
        assert_eq!(
            access.export_default_dir(&file),
            None,
            "a deleted folder is not offered"
        );

        access.remember_export("x.csv");
        assert!(
            BookmarkStore::load_from(&dir.join("bookmarks.json"))
                .last_export
                .is_some(),
            "a bare file name has no folder to record and leaves the entry alone"
        );
    }

    #[test]
    fn the_last_export_folder_is_bookmarked_best_effort_and_survives_a_relaunch() {
        let (dir, file) = fixture("export-relaunch");
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.remember_export(&s(&out.join("x.csv")));
        assert_eq!(fake.created(), [s(&out)]);
        let saved = BookmarkStore::load_from(&dir.join("bookmarks.json"));
        assert_eq!(saved.last_export.as_ref().unwrap().path, s(&out));
        assert!(saved.last_export.as_ref().unwrap().bookmark.is_some());

        let relaunch = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(relaunch.clone()), Some(&dir));
        assert_eq!(access.export_default_dir(&file), Some(s(&out)));
        assert_eq!(relaunch.starts(), 1, "resolved from the bookmark");
        assert_eq!(relaunch.stops(), 1);

        // Under the sandbox the folder is usually not bookmarkable: the
        // bare path is kept and still offered.
        let denied = FakeBookmarks::default();
        denied.make_uncreatable(&s(&out));
        let access = FileAccess::load(Box::new(denied.clone()), Some(&dir));
        access.remember_export(&s(&out.join("y.csv")));
        let saved = BookmarkStore::load_from(&dir.join("bookmarks.json"));
        assert_eq!(saved.last_export.as_ref().unwrap().bookmark, None);
        assert_eq!(access.export_default_dir(&file), Some(s(&out)));
        assert_eq!(denied.starts(), 0);

        // A bookmark that no longer resolves falls back to the path too.
        access.remember_export(&s(&out.join("z.csv")));
        let revoked = FakeBookmarks::default();
        revoked.revoke(&s(&out));
        let access = FileAccess::load(Box::new(revoked), Some(&dir));
        assert_eq!(access.export_default_dir(&file), Some(s(&out)));
    }

    #[test]
    fn a_stale_export_bookmark_is_recreated_and_saved() {
        let (dir, file) = fixture("export-stale");
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.remember_export(&s(&out.join("x.csv")));

        fake.mark_stale(&s(&out));
        assert_eq!(access.export_default_dir(&file), Some(s(&out)));
        assert_eq!(fake.created(), [s(&out), s(&out)], "re-created from the resolved URL");
        assert!(fake.active().is_empty());
        assert!(BookmarkStore::load_from(&dir.join("bookmarks.json"))
            .last_export
            .is_some());
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

    fn tab_state(page: u32) -> SessionTabState {
        SessionTabState {
            view_mode: Some("browse".into()),
            current_page: Some(page),
            active_filter: None,
        }
    }

    #[test]
    fn a_saved_session_reuses_the_recent_bookmark_and_comes_back_after_a_relaunch() {
        let (dir, file) = fixture("session");
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.remember_file(&file).unwrap();
        access
            .save_session(vec![(file.clone(), tab_state(3))], Some(file.clone()))
            .unwrap();
        assert_eq!(
            fake.created(),
            std::slice::from_ref(&file),
            "the tab shares the recent entry's bookmark"
        );
        let saved = BookmarkStore::load_from(&dir.join("bookmarks.json"));
        assert_eq!(saved.session_tabs()[0].bookmark, saved.recent[0].bookmark);
        assert_eq!(saved.session_tabs()[0].name, "a.parquet");

        let relaunch = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(relaunch.clone()), Some(&dir));
        let session = access.session_tabs();
        assert_eq!(session.active.as_deref(), Some(file.as_str()));
        assert_eq!(session.tabs.len(), 1);
        assert_eq!(session.tabs[0].path, file);
        assert_eq!(session.tabs[0].state, tab_state(3));
        assert!(session.tabs[0].available);
        assert_eq!(relaunch.starts(), 1, "probed through the bookmark");
        assert_eq!(relaunch.stops(), 1, "the probe's grant ends with it");

        // Reopened through the cache's normal path: the grant is held.
        access.acquire(&file).unwrap();
        assert_eq!(relaunch.active(), std::slice::from_ref(&file));
    }

    #[test]
    fn a_tab_forgotten_by_recent_files_reopens_from_its_own_bookmark() {
        let (dir, file) = fixture("session-own-bookmark");
        let other = s(&dir.join("data").join("b.parquet"));
        std::fs::write(&other, b"parquet").unwrap();
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.remember_file(&file).unwrap();
        // `other` was never remembered (say the recording failed): the save
        // creates its bookmark, once.
        access
            .save_session(
                vec![(file.clone(), tab_state(1)), (other.clone(), tab_state(1))],
                None,
            )
            .unwrap();
        access
            .save_session(
                vec![(other.clone(), tab_state(2)), (file.clone(), tab_state(1))],
                Some(other.clone()),
            )
            .unwrap();
        assert_eq!(fake.created(), [file.clone(), other.clone()]);
        access.clear_recent();

        let relaunch = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(relaunch.clone()), Some(&dir));
        assert!(access.recent_files().is_empty());
        let session = access.session_tabs();
        assert_eq!(
            session.tabs.iter().map(|t| t.path.as_str()).collect::<Vec<_>>(),
            [other.as_str(), file.as_str()],
            "the last save's order"
        );
        assert!(session.tabs.iter().all(|t| t.available));
        assert_eq!(session.active.as_deref(), Some(other.as_str()));
        access.acquire(&file).unwrap();
        access.acquire(&other).unwrap();
        assert_eq!(relaunch.active(), {
            let mut both = vec![file.clone(), other.clone()];
            both.sort();
            both
        });
    }

    #[test]
    fn a_session_tab_whose_bookmark_is_dead_or_whose_file_is_gone_is_unavailable() {
        let (dir, file) = fixture("session-missing");
        let other = s(&dir.join("data").join("b.parquet"));
        std::fs::write(&other, b"parquet").unwrap();
        let fake = FakeBookmarks::default();
        let access = FileAccess::load(Box::new(fake.clone()), Some(&dir));
        access.remember_file(&file).unwrap();
        access.remember_file(&other).unwrap();
        access
            .save_session(
                vec![(file.clone(), tab_state(1)), (other.clone(), tab_state(1))],
                Some(file.clone()),
            )
            .unwrap();

        let relaunch = FakeBookmarks::default();
        relaunch.revoke(&file);
        let access = FileAccess::load(Box::new(relaunch.clone()), Some(&dir));
        let session = access.session_tabs();
        assert_eq!(
            session.tabs.iter().map(|t| t.available).collect::<Vec<_>>(),
            [false, true]
        );
        assert_eq!(
            session.active.as_deref(),
            Some(file.as_str()),
            "the store is reported as it is; the webview picks another tab"
        );
        assert_eq!(relaunch.stops(), relaunch.starts(), "probes hold nothing");
        assert_eq!(
            BookmarkStore::load_from(&dir.join("bookmarks.json"))
                .session_tabs()
                .len(),
            2,
            "listing does not prune"
        );

        // The webview reopens what it could and saves that.
        access
            .save_session(vec![(other.clone(), tab_state(1))], Some(other.clone()))
            .unwrap();
        let saved = BookmarkStore::load_from(&dir.join("bookmarks.json"));
        assert_eq!(saved.session_tabs().len(), 1);
        assert_eq!(saved.session_tabs()[0].path, other);

        // The bookmark resolves but the file itself is gone.
        std::fs::remove_file(&other).unwrap();
        let access = FileAccess::load(Box::new(FakeBookmarks::default()), Some(&dir));
        assert!(!access.session_tabs().tabs[0].available);
    }

    #[test]
    fn without_bookmarks_the_session_is_kept_by_path_alone() {
        let (dir, file) = fixture("session-noop");
        let access = FileAccess::load(Box::new(NoopBookmarks), Some(&dir));
        access
            .save_session(vec![(file.clone(), tab_state(1))], Some(file.clone()))
            .unwrap();
        let access = FileAccess::load(Box::new(NoopBookmarks), Some(&dir));
        assert!(access.session_tabs().tabs[0].available);
        std::fs::remove_file(&file).unwrap();
        assert!(!access.session_tabs().tabs[0].available);

        let disabled = FileAccess::disabled();
        disabled.save_session(Vec::new(), None).unwrap();
        assert!(disabled.session_tabs().tabs.is_empty());
    }
}
