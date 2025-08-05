import { useState, useCallback, DragEvent, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { DataViewer } from "./components/DataViewer";

interface RecentFile {
  path: string;
  name: string;
  lastAccessed: string;
  size: string;
}

function App() {
  const [isDragging, setIsDragging] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);

  useEffect(() => {
    // Listen for file drop events from Tauri v2
    const unlisten = listen('tauri://drag-drop', async (event: any) => {
      console.log('File drop event:', event);
      const files = event.payload.paths;
      if (files && files.length > 0 && files[0].endsWith('.parquet')) {
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

    console.log('Web drop event:', e.dataTransfer);
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const file = files[0];
      console.log('Dropped file:', file);
      
      // In Tauri, files dropped from the file system have webkitRelativePath
      // Use the file name for now, as we'll handle the full path via Tauri events
      if (file.name.endsWith('.parquet')) {
        // For web drops, we might not have the full path
        // The Tauri file-drop event will handle this properly
        console.log('Parquet file detected:', file.name);
      }
    }
  }, []);

  const openParquetFile = async (path: string) => {
    try {
      // Verify the file can be opened
      await invoke("open_parquet_file", { path });
      setCurrentFile(path);
    } catch (error) {
      console.error("Failed to open parquet file:", error);
      alert(`Failed to open file: ${error}`);
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

  if (currentFile) {
    return (
      <DataViewer 
        filePath={currentFile} 
        onClose={() => setCurrentFile(null)} 
      />
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 shadow-sm">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center shadow-sm">
                <span className="text-white font-bold text-sm">P</span>
              </div>
              <h1 className="text-xl font-semibold text-slate-900">Parqsee</h1>
            </div>
            <span className="text-sm text-slate-500">Fast and simple Parquet file viewer</span>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={handleBrowse}
              className="inline-flex items-center px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors shadow-sm"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              Open File
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-4xl mx-auto">
          {/* Drop Zone */}
          <div
            className={`
              relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-200
              ${isDragging 
                ? 'border-blue-500 bg-blue-50 shadow-lg transform scale-[1.02]' 
                : 'border-slate-300 bg-white hover:border-slate-400 hover:shadow-md'
              }
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="px-12 py-16 text-center">
              <div className={`inline-flex items-center justify-center w-20 h-20 rounded-full mb-6 transition-colors ${
                isDragging ? 'bg-blue-100' : 'bg-slate-100'
              }`}>
                <svg 
                  className={`w-10 h-10 transition-colors ${
                    isDragging ? 'text-blue-600' : 'text-slate-400'
                  }`}
                  fill="none" 
                  viewBox="0 0 24 24" 
                  stroke="currentColor"
                >
                  <path 
                    strokeLinecap="round" 
                    strokeLinejoin="round" 
                    strokeWidth={1.5} 
                    d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" 
                  />
                </svg>
              </div>
              
              <h2 className="text-xl font-semibold text-slate-900 mb-2">
                Drop your Parquet file here
              </h2>
              <p className="text-sm text-slate-600 mb-6">
                or click the button below to browse
              </p>
              
              <button
                onClick={handleBrowse}
                className="inline-flex items-center px-6 py-2.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors"
              >
                Browse Files
              </button>
              
              <p className="mt-6 text-xs text-slate-500">
                Supports .parquet files • Press ⌘+O to open
              </p>
            </div>
            
            {/* Decorative elements */}
            <div className="absolute top-0 right-0 -mt-12 -mr-12 w-40 h-40 bg-blue-100 rounded-full opacity-10"></div>
            <div className="absolute bottom-0 left-0 -mb-12 -ml-12 w-32 h-32 bg-purple-100 rounded-full opacity-10"></div>
          </div>

          {/* Recent Files */}
          {recentFiles.length > 0 && (
            <div className="mt-12">
              <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center">
                <svg className="w-5 h-5 mr-2 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Recent Files
              </h3>
              <div className="space-y-2">
                {recentFiles.map((file, index) => (
                  <button
                    key={index}
                    onClick={() => openParquetFile(file.path)}
                    className="w-full text-left p-4 bg-white rounded-lg border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all group"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center group-hover:bg-slate-200 transition-colors">
                          <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                        </div>
                        <div>
                          <p className="font-medium text-slate-900 group-hover:text-blue-600 transition-colors">
                            {file.name}
                          </p>
                          <p className="text-sm text-slate-500">
                            {file.path}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium text-slate-700">
                          {file.size}
                        </p>
                        <p className="text-xs text-slate-500">
                          {file.lastAccessed}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Features */}
          <div className="mt-16 grid grid-cols-3 gap-6">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-100 text-blue-600 rounded-lg mb-3">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h4 className="font-medium text-slate-900 mb-1">Fast Performance</h4>
              <p className="text-sm text-slate-600">Native Rust backend for blazing fast file processing</p>
            </div>
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-green-100 text-green-600 rounded-lg mb-3">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h4 className="font-medium text-slate-900 mb-1">Easy to Use</h4>
              <p className="text-sm text-slate-600">Simple drag & drop interface with keyboard shortcuts</p>
            </div>
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-purple-100 text-purple-600 rounded-lg mb-3">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                </svg>
              </div>
              <h4 className="font-medium text-slate-900 mb-1">Large Files</h4>
              <p className="text-sm text-slate-600">Efficient pagination for handling massive datasets</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;