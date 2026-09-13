import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../lib/tauri';
import {
  RecentFile,
  listRecentFiles,
  removeRecentFile as apiRemoveRecentFile,
  clearRecentFiles as apiClearRecentFiles,
} from '../features/welcome/api';

export type { RecentFile };

interface RecentFilesContextType {
  recentFiles: RecentFile[];
  /** Put a file the backend just recorded (see `rememberFile`) at the front of the list. */
  upsertRecentFile: (file: RecentFile) => void;
  clearRecentFiles: () => void;
  removeRecentFile: (path: string) => void;
}

const RecentFilesContext = createContext<RecentFilesContextType | undefined>(undefined);
/** Where the list lived before it moved into the backend's store. */
const LEGACY_STORAGE_KEY = 'parqsee-recent-files';

/**
 * Recent Files as the backend keeps them. The list is owned by Rust
 * (bookmarks.json in the app data directory, next to the security-scoped
 * bookmarks that reopen the files under the sandbox); this context mirrors
 * it and applies each change locally so the UI does not wait on a round
 * trip.
 */
export function RecentFilesProvider({ children }: { children: ReactNode }) {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  // Bumped by every local change to the mirror. A listing asked for before
  // one of them describes the store from before it, so applying it would
  // undo the change; see `adoptLatestListing`.
  const generationRef = useRef(0);
  // Resolves when every backend write this context has sent so far has
  // settled. A re-listing waits on it, or it could read the store before a
  // Clear all / Remove has landed and bring the entries back.
  const writesRef = useRef<Promise<void>>(Promise.resolve());

  /** Send a change to the store, and keep it in `writesRef` until it settles. */
  const trackWrite = useCallback((write: Promise<unknown>, message: string) => {
    const settled = write.then(
      () => undefined,
      error => {
        console.error(message, error);
      },
    );
    writesRef.current = Promise.all([writesRef.current, settled]).then(() => undefined);
  }, []);

  // The mirror starts from the backend's list, but the store can change
  // while that listing is in flight — a file opened from Finder or the
  // Welcome screen, Clear all, Remove, File › Open Recent › Clear Menu. A
  // listing describes the store as it was when it was asked for, so it is
  // adopted only when nothing has touched the mirror since; otherwise the
  // snapshot is from before the change and the authoritative list is asked
  // for again. Merging the two instead would resurrect exactly what a clear
  // or a remove took out.
  const adoptLatestListing = useCallback(async (cancelled: () => boolean) => {
    // The first listing goes out with the mount. A retry waits for the
    // writes this context has sent, or it would read the store before the
    // clear or the remove that made it necessary has landed. Nothing can
    // change the mirror between that wait and the call that follows it:
    // both run in one turn.
    let listing = listRecentFiles();
    for (;;) {
      const generation = generationRef.current;
      const files = await listing;
      if (cancelled()) return;
      if (generationRef.current === generation) {
        setRecentFiles(files);
        return;
      }
      await writesRef.current;
      if (cancelled()) return;
      listing = listRecentFiles();
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Storage may be unavailable; there is nothing to migrate anyway.
    }
    if (!isTauri()) return;
    let cancelled = false;
    // A listing that never arrives leaves the mirror on what the session
    // itself did; the changes below keep working either way.
    adoptLatestListing(() => cancelled).catch(error =>
      console.error('Failed to list recent files:', error),
    );
    return () => {
      cancelled = true;
    };
  }, [adoptLatestListing]);

  // File › Open Recent › Clear Menu clears the store in Rust (see menu.rs)
  // and says so; the mirror follows. A pick from that menu needs nothing
  // here: it arrives as `file-drop` and is an ordinary open.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen('recent-files-cleared', () => {
      generationRef.current += 1;
      setRecentFiles([]);
    });
    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  // The cap is the backend's (`MAX_RECENT` in services/access/store.rs):
  // the entry it drops is the one the next listing leaves out, and holding
  // a copy of the number here only made the mirror disagree with the store
  // until the next launch whenever the two drifted apart.
  const upsertRecentFile = useCallback((file: RecentFile) => {
    // No write to track: the caller has `rememberFile`'s answer in hand, so
    // the store already holds the entry.
    generationRef.current += 1;
    setRecentFiles(prev => [file, ...prev.filter(f => f.path !== file.path)]);
  }, []);

  const clearRecentFiles = useCallback(() => {
    generationRef.current += 1;
    setRecentFiles([]);
    if (isTauri()) {
      trackWrite(apiClearRecentFiles(), 'Failed to clear recent files:');
    }
  }, [trackWrite]);

  const removeRecentFile = useCallback(
    (path: string) => {
      generationRef.current += 1;
      setRecentFiles(prev => prev.filter(f => f.path !== path));
      if (isTauri()) {
        trackWrite(apiRemoveRecentFile(path), 'Failed to remove recent file:');
      }
    },
    [trackWrite],
  );

  return (
    <RecentFilesContext.Provider value={{ recentFiles, upsertRecentFile, clearRecentFiles, removeRecentFile }}>
      {children}
    </RecentFilesContext.Provider>
  );
}

export function useRecentFiles() {
  const context = useContext(RecentFilesContext);
  if (!context) {
    throw new Error('useRecentFiles must be used within a RecentFilesProvider');
  }
  return context;
}
