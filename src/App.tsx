import { useState, useCallback, DragEvent, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

interface RecentFile {
  path: string;
  name: string;
  lastAccessed: string;
  size: string;
}

function App() {
  const [isDragging, setIsDragging] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);

  useEffect(() => {
    // Listen for file drop events from Tauri
    const unlisten = listen<string[]>('tauri://drop', async (event) => {
      const files = event.payload;
      if (files.length > 0 && files[0].endsWith('.parquet')) {
        openParquetFile(files[0]);
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const file = files[0];
      if (file.path && file.path.endsWith('.parquet')) {
        openParquetFile(file.path);
      }
    }
  }, []);

  const openParquetFile = async (path: string) => {
    try {
      await invoke("open_parquet_file", { path });
    } catch (error) {
      console.error("Failed to open parquet file:", error);
    }
  };

  const handleBrowse = async () => {
    try {
      const selected = await open({
        filters: [{
          name: 'Parquet Files',
          extensions: ['parquet']
        }]
      });
      
      if (selected && typeof selected === 'string') {
        openParquetFile(selected);
      }
    } catch (error) {
      console.error("Failed to select file:", error);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="container mx-auto px-4 py-8">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-800 dark:text-gray-100 mb-2">
            Parqsee
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Fast and simple Parquet file viewer
          </p>
        </header>

        <main className="max-w-4xl mx-auto">
          <div
            className={`
              border-2 border-dashed rounded-lg p-16 text-center transition-colors
              ${isDragging 
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' 
                : 'border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600'
              }
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <svg 
              className="mx-auto h-16 w-16 text-gray-400 mb-4" 
              fill="none" 
              viewBox="0 0 24 24" 
              stroke="currentColor"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={2} 
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" 
              />
            </svg>
            
            <p className="text-xl mb-4 text-gray-700 dark:text-gray-300">
              Drop Parquet file here or click to browse
            </p>
            
            <button
              onClick={handleBrowse}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              Browse Files
            </button>
            
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
              Supports .parquet files
            </p>
          </div>

          {recentFiles.length > 0 && (
            <div className="mt-12">
              <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200 mb-4">
                Recent Files
              </h2>
              <div className="space-y-2">
                {recentFiles.map((file, index) => (
                  <button
                    key={index}
                    onClick={() => openParquetFile(file.path)}
                    className="w-full text-left p-4 bg-white dark:bg-gray-800 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="font-medium text-gray-800 dark:text-gray-200">
                          {file.name}
                        </p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {file.path}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {file.size}
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          {file.lastAccessed}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </main>

        <footer className="mt-16 text-center text-sm text-gray-500 dark:text-gray-400">
          <p>Press ⌘+O to open file</p>
        </footer>
      </div>
    </div>
  );
}

export default App;