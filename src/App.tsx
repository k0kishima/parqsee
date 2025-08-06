import { useState, useCallback, DragEvent, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { DataViewer } from "./components/DataViewer";
import { SettingsModal } from "./components/SettingsModal";
import FileExplorer from "./components/FileExplorer";
import TabBar from "./components/TabBar";
import { useRecentFiles } from "./contexts/RecentFilesContext";
import { useSettings } from "./contexts/SettingsContext";
import { Menu } from "lucide-react";

interface Tab {
  id: string;
  path: string;
  name: string;
}

function App() {
  const [isDragging, setIsDragging] = useState(false);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const { recentFiles, addRecentFile } = useRecentFiles();
  const { settings, effectiveTheme } = useSettings();
  

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+W or Ctrl+W to close current tab
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        if (activeTabId) {
          handleTabClose(activeTabId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTabId, tabs]);

  useEffect(() => {
    // Only listen for Tauri events if we're in a Tauri environment
    const isTauri = (window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__ || typeof listen === 'function';
    
    if (isTauri) {
      // Listen for file drop events from Tauri v2
      // Use the custom event we emit from Rust
      const unlisten = listen('file-drop', async (event: any) => {
        console.log('File drop event:', event);
        
        // The payload should be an array of paths
        const files = event.payload || [];
        
        console.log('Dropped files:', files);
        
        if (files.length > 0) {
          const parquetFile = files.find((f: string) => f.endsWith('.parquet'));
          if (parquetFile) {
            console.log('Opening parquet file:', parquetFile);
            openParquetFile(parquetFile);
          } else {
            alert('Please drop a .parquet file');
          }
        }
      });

      return () => {
        unlisten.then(fn => fn());
      };
    }
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
      // Check if we can use Tauri APIs
      const isTauri = (window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__ || typeof invoke === 'function';
      
      if (isTauri) {
        // Verify the file can be opened
        await invoke("open_parquet_file", { path });
        
        // Get file info and add to recent files
        const fileInfo = await invoke<{ path: string; name: string; size: number }>("get_file_info", { path });
        
        addRecentFile({
          path: fileInfo.path,
          name: fileInfo.name,
          lastAccessed: new Date().toLocaleString(),
          size: fileInfo.size
        });
        
        // Check if file is already open in a tab
        const existingTab = tabs.find(tab => tab.path === path);
        if (existingTab) {
          setActiveTabId(existingTab.id);
          setCurrentFile(path);
        } else {
          // Create new tab
          const newTab: Tab = {
            id: Date.now().toString(),
            path: fileInfo.path,
            name: fileInfo.name
          };
          setTabs([...tabs, newTab]);
          setActiveTabId(newTab.id);
          setCurrentFile(path);
        }
      } else {
        // For browser testing, just set the file path
        console.log("Running in browser, simulating file open:", path);
        setCurrentFile(path);
      }
    } catch (error) {
      console.error("Failed to open parquet file:", error);
      alert(`Failed to open file: ${error}`);
    }
  };

  const handleBrowse = async () => {
    try {
      // Check if we can use Tauri APIs
      const isTauri = (window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__ || typeof open === 'function';
      
      if (isTauri) {
        const selected = await open({
          filters: [{
            name: 'Parquet Files',
            extensions: ['parquet']
          }]
        });
        
        if (selected && typeof selected === 'string') {
          openParquetFile(selected);
        }
      } else {
        alert("File browser is only available in the desktop app. Please drag and drop a file instead.");
      }
    } catch (error) {
      console.error("Failed to select file:", error);
    }
  };

  const handleTabSelect = (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      setActiveTabId(tabId);
      setCurrentFile(tab.path);
    }
  };

  const handleTabClose = (tabId: string) => {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    const newTabs = tabs.filter(t => t.id !== tabId);
    setTabs(newTabs);

    if (activeTabId === tabId) {
      if (newTabs.length > 0) {
        // Switch to adjacent tab
        const newIndex = Math.min(tabIndex, newTabs.length - 1);
        setActiveTabId(newTabs[newIndex].id);
        setCurrentFile(newTabs[newIndex].path);
      } else {
        // No more tabs
        setActiveTabId(null);
        setCurrentFile(null);
      }
    }
  };

  if (currentFile && tabs.length > 0) {
    return (
      <div className="h-screen flex">
        {/* Sidebar */}
        <div className={`transition-all duration-300 ${isSidebarOpen ? 'w-64' : 'w-0'} overflow-hidden flex-shrink-0`}>
          <FileExplorer
            currentPath={currentFile}
            onFileSelect={openParquetFile}
            className="h-full"
          />
        </div>
        
        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header with toggle button */}
          <div className={`px-2 py-2 flex items-center border-b ${
            effectiveTheme === 'dark' 
              ? 'bg-gray-800 border-gray-700' 
              : 'bg-white border-gray-200'
          }`}>
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className={`p-2 rounded-md transition-colors ${
                effectiveTheme === 'dark'
                  ? 'text-gray-300 hover:bg-gray-700'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
              title={isSidebarOpen ? "Hide sidebar" : "Show sidebar"}
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className={`ml-3 text-sm ${
              effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
            }`}>File Explorer</span>
          </div>
          
          {/* Tab Bar */}
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabSelect={handleTabSelect}
            onTabClose={handleTabClose}
          />
          
          {/* DataViewer takes remaining space */}
          <div className="flex-1 overflow-hidden">
            <DataViewer 
              filePath={currentFile} 
              onClose={() => {
                // Close current tab when DataViewer close button is clicked
                if (activeTabId) {
                  handleTabClose(activeTabId);
                }
              }} 
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-secondary">
      {/* Header */}
      <div className="bg-primary border-b border-primary shadow-sm">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center shadow-sm">
                <span className="text-white font-bold text-sm">P</span>
              </div>
              <h1 className="text-xl font-semibold text-primary">Parqsee</h1>
            </div>
            <span className="text-sm text-secondary">Fast and simple Parquet file viewer</span>
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
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 text-secondary hover:bg-tertiary rounded-md transition-colors"
              title="Settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
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
                : 'border-primary bg-primary hover:border-secondary hover:shadow-md'
              }
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="px-12 py-16 text-center">
              <div className={`inline-flex items-center justify-center w-20 h-20 rounded-full mb-6 transition-colors ${
                isDragging ? 'bg-blue-100' : 'bg-tertiary'
              }`}>
                <svg 
                  className={`w-10 h-10 transition-colors ${
                    isDragging ? 'text-blue-600' : 'text-secondary'
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
              
              <h2 className="text-xl font-semibold text-primary mb-2">
                Drop your Parquet file here
              </h2>
              <p className="text-sm text-secondary mb-6">
                or click the button below to browse
              </p>
              
              <button
                onClick={handleBrowse}
                className="inline-flex items-center px-6 py-2.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors"
              >
                Browse Files
              </button>
              
              <p className="mt-6 text-xs text-tertiary">
                Supports .parquet files • Press ⌘+O to open
              </p>
            </div>
            
            {/* Decorative elements */}
            <div className="absolute top-0 right-0 -mt-12 -mr-12 w-40 h-40 bg-blue-100 rounded-full opacity-10"></div>
            <div className="absolute bottom-0 left-0 -mb-12 -ml-12 w-32 h-32 bg-purple-100 rounded-full opacity-10"></div>
          </div>

          {/* Recent Files */}
          {/* Debug: Always show section if showRecentFiles is true */}
          {settings?.showRecentFiles && (
            <div className="mt-12">
              <h3 className="text-lg font-semibold text-primary mb-4 flex items-center">
                <svg className="w-5 h-5 mr-2 text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Recent Files
              </h3>
              <div className="space-y-2">
                {recentFiles.length === 0 ? (
                  <p className="text-sm text-tertiary">No recent files yet. Open a Parquet file to see it here.</p>
                ) : (
                  recentFiles.map((file) => {
                  const formatFileSize = (bytes: number): string => {
                    if (bytes < 1024) return bytes + ' B';
                    else if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
                    else if (bytes < 1073741824) return Math.round(bytes / 1048576) + ' MB';
                    else return Math.round(bytes / 1073741824) + ' GB';
                  };
                  
                  return (
                    <button
                      key={file.path}
                      onClick={() => openParquetFile(file.path)}
                      className="w-full text-left p-4 bg-primary rounded-lg border border-primary hover:border-secondary hover:shadow-sm transition-all group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 bg-tertiary rounded-lg flex items-center justify-center group-hover:bg-secondary transition-colors">
                            <svg className="w-5 h-5 text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          </div>
                          <div>
                            <p className="font-medium text-primary group-hover:text-blue-600 transition-colors">
                              {file.name}
                            </p>
                            <p className="text-sm text-tertiary">
                              {file.path}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-medium text-secondary">
                            {formatFileSize(file.size)}
                          </p>
                          <p className="text-xs text-tertiary">
                            {file.lastAccessed}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                }))}
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
              <h4 className="font-medium text-primary mb-1">Fast Performance</h4>
              <p className="text-sm text-secondary">Native Rust backend for blazing fast file processing</p>
            </div>
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-green-100 text-green-600 rounded-lg mb-3">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h4 className="font-medium text-primary mb-1">Easy to Use</h4>
              <p className="text-sm text-secondary">Simple drag & drop interface with keyboard shortcuts</p>
            </div>
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-purple-100 text-purple-600 rounded-lg mb-3">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                </svg>
              </div>
              <h4 className="font-medium text-primary mb-1">Large Files</h4>
              <p className="text-sm text-secondary">Efficient pagination for handling massive datasets</p>
            </div>
          </div>
        </div>
      </div>
      
      {/* Settings Modal */}
      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
      />
    </div>
  );
}

export default App;