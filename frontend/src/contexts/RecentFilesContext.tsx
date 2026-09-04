import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
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
const MAX_RECENT_FILES = 5;
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

  const upsertRecentFile = useCallback((file: RecentFile) => {
    setRecentFiles(prev => [file, ...prev.filter(f => f.path !== file.path)].slice(0, MAX_RECENT_FILES));
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
