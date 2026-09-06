import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
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

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Storage may be unavailable; there is nothing to migrate anyway.
    }
    if (!isTauri()) return;
    listRecentFiles()
      .then(setRecentFiles)
      .catch(error => console.error('Failed to list recent files:', error));
  }, []);

  // File › Open Recent › Clear Menu clears the store in Rust (see menu.rs)
  // and says so; the mirror follows. A pick from that menu needs nothing
  // here: it arrives as `file-drop` and is an ordinary open.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen('recent-files-cleared', () => setRecentFiles([]));
    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  // The cap is the backend's (`MAX_RECENT` in services/access/store.rs):
  // the entry it drops is the one the next listing leaves out, and holding
  // a copy of the number here only made the mirror disagree with the store
  // until the next launch whenever the two drifted apart.
  const upsertRecentFile = useCallback((file: RecentFile) => {
    setRecentFiles(prev => [file, ...prev.filter(f => f.path !== file.path)]);
  }, []);

  const clearRecentFiles = useCallback(() => {
    setRecentFiles([]);
    if (isTauri()) {
      apiClearRecentFiles().catch(error => console.error('Failed to clear recent files:', error));
    }
  }, []);

  const removeRecentFile = useCallback((path: string) => {
    setRecentFiles(prev => prev.filter(f => f.path !== path));
    if (isTauri()) {
      apiRemoveRecentFile(path).catch(error => console.error('Failed to remove recent file:', error));
    }
  }, []);

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
