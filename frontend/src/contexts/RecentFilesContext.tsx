import { createContext, useContext, useState, useEffect, ReactNode } from 'react';


export interface RecentFile {
  path: string;
  name: string;
  lastAccessed: string;
  size: number;
}

interface RecentFilesContextType {
  recentFiles: RecentFile[];
  addRecentFile: (file: RecentFile) => void;
  clearRecentFiles: () => void;
  removeRecentFile: (path: string) => void;
}

const RecentFilesContext = createContext<RecentFilesContextType | undefined>(undefined);
const MAX_RECENT_FILES = 5;
const RECENT_FILES_STORAGE_KEY = 'parqsee-recent-files';

/**
 * Read the persisted list, dropping anything unusable. A corrupt entry used
 * to throw out of the provider and leave the app blank with no way to recover.
 */
export function loadRecentFiles(): RecentFile[] {
  try {
    const saved = localStorage.getItem(RECENT_FILES_STORAGE_KEY);
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is RecentFile => !!f && typeof f === 'object' && typeof (f as RecentFile).path === 'string'
    );
  } catch (e) {
    console.error('Failed to parse recent files', e);
    return [];
  }
}

export function RecentFilesProvider({ children }: { children: ReactNode }) {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(loadRecentFiles);

  useEffect(() => {
    // Save recent files to localStorage when they change
    localStorage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify(recentFiles));
  }, [recentFiles]);

  const addRecentFile = (file: RecentFile) => {
    setRecentFiles(prev => {
      // Remove existing entry if present
      const filtered = prev.filter(f => f.path !== file.path);

      // Add new file at the beginning
      const updated = [file, ...filtered];

      // Limit to MAX_RECENT_FILES
      return updated.slice(0, MAX_RECENT_FILES);
    });
  };

  const clearRecentFiles = () => {
    setRecentFiles([]);
  };

  const removeRecentFile = (path: string) => {
    setRecentFiles(prev => prev.filter(f => f.path !== path));
  };

  return (
    <RecentFilesContext.Provider value={{ recentFiles, addRecentFile, clearRecentFiles, removeRecentFile }}>
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