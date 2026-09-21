//! Security-scoped bookmarks through Foundation's `NSURL`.
//!
//! Requires the `com.apple.security.files.bookmarks.app-scope` entitlement
//! (see `backend/Entitlements.plist`). Outside the sandbox — `pnpm tauri
//! dev`, the bridge — the calls still succeed; `startAccessing…` just
//! returns false there, and a false start is not paired with a stop.

use super::{AccessToken, BookmarkProvider, Resolved};
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{
    NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
};
use std::path::{Path, PathBuf};

pub struct MacBookmarks;

/// A URL whose security scope has been started; stopped on drop.
struct ScopedUrl {
    url: Retained<NSURL>,
    started: bool,
}

impl Drop for ScopedUrl {
    fn drop(&mut self) {
        if self.started {
            // SAFETY: paired with the `startAccessingSecurityScopedResource`
            // that set `started`, on the same URL object.
            unsafe { self.url.stopAccessingSecurityScopedResource() };
        }
    }
}

impl BookmarkProvider for MacBookmarks {
    fn create(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let data = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::WithSecurityScope,
                None,
                None,
            )
            .map_err(|e| e.localizedDescription().to_string())?;
        Ok(Some(data.to_vec()))
    }

    fn resolve(&self, bookmark: &[u8]) -> Result<Resolved, String> {
        let data = NSData::with_bytes(bookmark);
        let mut stale = Bool::NO;
        // SAFETY: `stale` outlives the call, which is the only requirement.
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut stale,
            )
        }
        .map_err(|e| e.localizedDescription().to_string())?;
        let path = url
            .path()
            .map(|p| p.to_string())
            .ok_or_else(|| "the bookmark resolved to a URL without a path".to_string())?;
        // SAFETY: plain method call on a valid URL; the stop is in `Drop`.
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        Ok(Resolved {
            path: PathBuf::from(path),
            stale: stale.as_bool(),
            token: AccessToken::new(ScopedUrl { url, started }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::test_support::temp_path;

    /// Unsandboxed, but the round trip through Foundation is real: a
    /// bookmark that resolves back to its file, and one that follows a move.
    #[test]
    fn bookmarks_round_trip_and_follow_a_move() {
        let file = temp_path("access-macos", "round-trip.parquet");
        std::fs::write(&file, b"x").unwrap();
        let provider = MacBookmarks;

        let bookmark = provider
            .create(&file)
            .unwrap()
            .expect("macOS always has bookmarks");
        let resolved = provider.resolve(&bookmark).unwrap();
        assert_eq!(
            resolved.path.canonicalize().unwrap(),
            file.canonicalize().unwrap()
        );
        assert!(!resolved.stale);
        drop(resolved);

        let moved = temp_path("access-macos", "moved.parquet");
        std::fs::rename(&file, &moved).unwrap();
        let resolved = provider.resolve(&bookmark).unwrap();
        assert_eq!(
            resolved.path.canonicalize().unwrap(),
            moved.canonicalize().unwrap()
        );

        std::fs::remove_file(&moved).unwrap();
        assert!(provider.resolve(&bookmark).is_err());
    }

    /// The path a bookmark resolves to is the canonical one — the symlink
    /// here stands in for `/tmp`, and for `/var`, which the temp directory
    /// itself is reached through. `FileAccess` records the path the user
    /// opened, so its checks have to reach past the difference.
    #[test]
    fn a_file_recorded_through_a_symlink_is_still_found() {
        let dir = temp_path("access-macos", "symlinked-path");
        std::fs::create_dir_all(dir.join("real")).unwrap();
        let link = dir.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(dir.join("real"), &link).unwrap();
        let file = link.join("f.parquet");
        std::fs::write(&file, b"x").unwrap();
        let path = file.to_string_lossy().into_owned();

        let access = crate::services::access::FileAccess::load(Box::new(MacBookmarks), Some(&dir));
        access.remember_file(&path).unwrap();
        // The tab is closed; the next check has to resolve the bookmark.
        access.release(&path);

        assert!(access.file_exists(&path));
    }
}
