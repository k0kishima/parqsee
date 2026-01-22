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

export function RecentFilesProvider({ children }: { children: ReactNode }) {
  // const { settings } = useSettings(); // Not used currently
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => {
    const saved = localStorage.getItem('parqsee-recent-files');
    return saved ? JSON.parse(saved) : [];
  });

  useEffect(() => {
    // Save recent files to localStorage when they change
    localStorage.setItem('parqsee-recent-files', JSON.stringify(recentFiles));
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