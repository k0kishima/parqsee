import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../contexts/SettingsContext";
import { SearchBar } from "./SearchBar";

interface DataViewerProps {
  filePath: string;
  onClose: () => void;
}

interface ColumnInfo {
  name: string;
  column_type: string;
}

interface ParquetMetadata {
  num_rows: number;
  num_columns: number;
  columns: ColumnInfo[];
}

export function DataViewer({ filePath, onClose }: DataViewerProps) {
  const { settings, effectiveTheme } = useSettings();
  const [metadata, setMetadata] = useState<ParquetMetadata | null>(null);
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const rowsPerPage = settings.rowsPerPage;
  
  // Track when search term changes but debounced hasn't fired yet
  const [pendingSearchTerm, setPendingSearchTerm] = useState("");
  const searchTimerRef = useRef<NodeJS.Timeout>();
  const tableContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadFile();
  }, [filePath]);

  useEffect(() => {
    if (metadata) {
      loadData();
    }
  }, [currentPage, metadata, rowsPerPage]);

  useEffect(() => {
    // Reset to first page when rows per page changes
    setCurrentPage(1);
  }, [rowsPerPage]);

  // Keyboard shortcut for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Cmd+F (Mac) or Ctrl+F (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadFile = async () => {
    try {
      setLoading(true);
      const meta = await invoke<ParquetMetadata>("open_parquet_file", { path: filePath });
      setMetadata(meta);
    } catch (err) {
      setError(err as string);
      setLoading(false);
    }
  };

  const loadData = async () => {
    if (!metadata) return;
    
    try {
      setLoading(true);
      const offset = (currentPage - 1) * rowsPerPage;
      const rows = await invoke<any[]>("read_parquet_data", { 
        path: filePath,
        offset,
        limit: rowsPerPage 
      });
      setData(rows);
      setLoading(false);
    } catch (err) {
      setError(err as string);
      setLoading(false);
    }
  };

  const totalPages = metadata ? Math.ceil(metadata.num_rows / rowsPerPage) : 1;
  const fileName = filePath.split('/').pop() || filePath;

  // Search functionality
  const searchMatches = useMemo(() => {
    if (!searchTerm || !metadata || !data) return [];

    const matches: Array<{ rowIndex: number; colIndex: number; value: string }> = [];
    const lowerSearchTerm = searchTerm.toLowerCase();

    // Search in column names
    metadata.columns.forEach((col, colIndex) => {
      if (col.name.toLowerCase().includes(lowerSearchTerm)) {
        matches.push({ rowIndex: -1, colIndex, value: col.name });
      }
    });

    // Search in data
    data.forEach((row, rowIndex) => {
      metadata.columns.forEach((col, colIndex) => {
        const value = row[col.name];
        if (value !== null && value !== undefined) {
          const stringValue = String(value);
          if (stringValue.toLowerCase().includes(lowerSearchTerm)) {
            matches.push({ rowIndex, colIndex, value: stringValue });
          }
        }
      });
    });

    return matches;
  }, [searchTerm, data, metadata]);

  const handleSearchChange = useCallback((term: string) => {
    setPendingSearchTerm(term);
    
    // Clear existing timer
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    // Show searching indicator only when there's text and after a short delay
    if (term.trim()) {
      // Delay before showing "Searching..." and performing search
      searchTimerRef.current = setTimeout(() => {
        setIsSearching(true);
        setSearchTerm(term);
        setCurrentMatchIndex(0);
        // Hide searching indicator shortly after
        setTimeout(() => {
          setIsSearching(false);
        }, 50); // Very short delay just to show the indicator
      }, 400); // Wait 400ms before starting search
    } else {
      // Clear search immediately if empty
      setSearchTerm(term);
      setCurrentMatchIndex(0);
      setIsSearching(false);
    }
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  const scrollToMatch = useCallback((matchIndex: number) => {
    if (!tableContainerRef.current || !searchMatches[matchIndex]) return;
    
    const match = searchMatches[matchIndex];
    
    // If it's a column header match
    if (match.rowIndex === -1) {
      const headerElement = tableContainerRef.current.querySelector(
        `thead th:nth-child(${match.colIndex + 1})`
      );
      if (headerElement) {
        headerElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    } else {
      // It's a data cell match
      const cellElement = tableContainerRef.current.querySelector(
        `tbody tr:nth-child(${match.rowIndex + 1}) td:nth-child(${match.colIndex + 1})`
      );
      if (cellElement) {
        cellElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    }
  }, [searchMatches]);

  const handleNextMatch = useCallback(() => {
    if (searchMatches.length > 0) {
      const newIndex = (currentMatchIndex + 1) % searchMatches.length;
      setCurrentMatchIndex(newIndex);
      scrollToMatch(newIndex);
    }
  }, [searchMatches, currentMatchIndex, scrollToMatch]);

  const handlePreviousMatch = useCallback(() => {
    if (searchMatches.length > 0) {
      const newIndex = currentMatchIndex === 0 ? searchMatches.length - 1 : currentMatchIndex - 1;
      setCurrentMatchIndex(newIndex);
      scrollToMatch(newIndex);
    }
  }, [searchMatches, currentMatchIndex, scrollToMatch]);

  // Highlight search term in text
  const highlightText = useCallback((text: string) => {
    if (!searchTerm || !text) return text;

    const lowerText = text.toLowerCase();
    const lowerSearchTerm = searchTerm.toLowerCase();
    const index = lowerText.indexOf(lowerSearchTerm);

    if (index === -1) return text;

    const beforeMatch = text.slice(0, index);
    const match = text.slice(index, index + searchTerm.length);
    const afterMatch = text.slice(index + searchTerm.length);

    return (
      <>
        {beforeMatch}
        <span className="bg-yellow-300 text-slate-900 font-semibold">{match}</span>
        {afterMatch}
      </>
    );
  }, [searchTerm]);

  // Check if a cell is the current match
  const isCurrentMatch = useCallback((rowIndex: number, colIndex: number) => {
    if (!searchMatches.length || currentMatchIndex >= searchMatches.length) return false;
    const match = searchMatches[currentMatchIndex];
    return match.rowIndex === rowIndex && match.colIndex === colIndex;
  }, [searchMatches, currentMatchIndex]);

  // Check if a column header is matched
  const isColumnMatch = useCallback((colIndex: number) => {
    return searchMatches.some(match => match.rowIndex === -1 && match.colIndex === colIndex);
  }, [searchMatches]);

  // Scroll to first match when search results change
  useEffect(() => {
    if (searchMatches.length > 0 && currentMatchIndex === 0) {
      // Small delay to ensure DOM is updated
      setTimeout(() => {
        scrollToMatch(0);
      }, 100);
    }
  }, [searchMatches, scrollToMatch]);

  if (error) {
    return (
      <div className={`h-full p-8 ${effectiveTheme === 'dark' ? 'bg-gray-900' : 'bg-slate-50'}`}>
        <div className="max-w-4xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-red-800 font-semibold mb-2 text-lg">Error Loading File</h2>
            <p className="text-red-600 mb-4">{error}</p>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors shadow-sm"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col relative ${effectiveTheme === 'dark' ? 'bg-gray-900' : 'bg-slate-50'}`}>
      {/* Search Bar */}
      <SearchBar
        isOpen={isSearchOpen}
        searchTerm={pendingSearchTerm || searchTerm}
        onSearchChange={handleSearchChange}
        onClose={() => {
          setIsSearchOpen(false);
          setSearchTerm("");
          setPendingSearchTerm("");
          setCurrentMatchIndex(0);
          setIsSearching(false);
        }}
        currentMatch={searchMatches.length > 0 ? currentMatchIndex + 1 : 0}
        totalMatches={searchMatches.length}
        onNext={handleNextMatch}
        onPrevious={handlePreviousMatch}
        isSearching={isSearching}
      />

      {/* Header */}
      <div className={`shadow-sm border-b ${effectiveTheme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-slate-200'}`}>
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <div>
              <h1 className={`text-xl font-semibold ${effectiveTheme === 'dark' ? 'text-gray-100' : 'text-slate-900'}`}>
                {fileName}
              </h1>
              {metadata && (
                <p className={`text-sm mt-0.5 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>
                  {metadata.num_rows.toLocaleString()} rows × {metadata.num_columns} columns
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setIsSearchOpen(true)}
              className={`inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors ${
                effectiveTheme === 'dark' 
                  ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600' 
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
              title="Search (⌘F / Ctrl+F)"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Search
            </button>
            <button
              onClick={loadData}
              className={`inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors ${
                effectiveTheme === 'dark' 
                  ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600' 
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
            <button
              className={`inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors ${
                effectiveTheme === 'dark' 
                  ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600' 
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Export
            </button>
            <button
              onClick={onClose}
              className={`inline-flex items-center px-3 py-1.5 text-sm rounded-md transition-colors ${
                effectiveTheme === 'dark' 
                  ? 'bg-gray-600 text-gray-200 hover:bg-gray-500' 
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
              <div className={`${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>Loading data...</div>
            </div>
          </div>
        ) : (
          <>
            {/* Table Container */}
            <div ref={tableContainerRef} className={`flex-1 overflow-auto shadow-inner ${effectiveTheme === 'dark' ? 'bg-gray-800' : 'bg-white'}`}>
              <table className="w-full text-sm">
                <thead className={`sticky top-0 z-10 border-b ${effectiveTheme === 'dark' ? 'bg-gray-700 border-gray-600' : 'bg-slate-100 border-slate-200'}`}>
                  <tr>
                    {metadata?.columns.map((col, index) => (
                      <th
                        key={index}
                        className={`px-4 py-3 text-left font-medium border-r last:border-r-0 ${
                          effectiveTheme === 'dark' ? 'text-gray-200 border-gray-600' : 'text-slate-700 border-slate-200'
                        } ${
                          isColumnMatch(index) ? 'bg-yellow-100' : ''
                        }`}
                      >
                        <div className="font-semibold">
                          {searchTerm && col.name.toLowerCase().includes(searchTerm.toLowerCase()) 
                            ? highlightText(col.name)
                            : col.name
                          }
                        </div>
                        <div className={`font-normal text-xs mt-0.5 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-500'}`}>
                          {col.column_type.replace("PhysicalType(", "").replace(")", "")}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((row, rowIndex) => (
                    <tr
                      key={rowIndex}
                      onClick={() => setSelectedRow(rowIndex)}
                      className={`
                        border-b cursor-pointer transition-colors
                        ${effectiveTheme === 'dark' ? 'border-gray-700' : 'border-slate-100'}
                        ${selectedRow === rowIndex 
                          ? effectiveTheme === 'dark' ? 'bg-blue-900 hover:bg-blue-800' : 'bg-blue-50 hover:bg-blue-100' 
                          : effectiveTheme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-slate-50'
                        }
                      `}
                    >
                      {metadata?.columns.map((col, colIndex) => (
                        <td
                          key={colIndex}
                          className={`px-4 py-2.5 text-sm border-r last:border-r-0 ${
                            effectiveTheme === 'dark' ? 'border-gray-700' : 'border-slate-100'
                          } ${
                            isCurrentMatch(rowIndex, colIndex) 
                              ? 'bg-orange-200' 
                              : searchTerm && row[col.name] !== null && String(row[col.name]).toLowerCase().includes(searchTerm.toLowerCase())
                              ? 'bg-yellow-100'
                              : ''
                          }`}
                        >
                          {row[col.name] !== null && row[col.name] !== undefined ? (
                            <span className={`font-mono text-xs ${effectiveTheme === 'dark' ? 'text-gray-200' : 'text-slate-900'}`}>
                              {searchTerm && String(row[col.name]).toLowerCase().includes(searchTerm.toLowerCase())
                                ? highlightText(String(row[col.name]))
                                : String(row[col.name])
                              }
                            </span>
                          ) : (
                            <span className={`italic font-mono text-xs ${effectiveTheme === 'dark' ? 'text-gray-500' : 'text-slate-400'}`}>NULL</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer with Pagination */}
            <div className={`px-6 py-3 flex items-center justify-between border-t ${effectiveTheme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-slate-200'}`}>
              <div className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>
                Showing {((currentPage - 1) * rowsPerPage) + 1} to{' '}
                {Math.min(currentPage * rowsPerPage, metadata?.num_rows || 0)} of{' '}
                {metadata?.num_rows.toLocaleString()} entries
              </div>
              
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className={`p-1 rounded disabled:opacity-50 disabled:cursor-not-allowed ${effectiveTheme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-slate-100'}`}
                >
                  <svg className={`w-5 h-5 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className={`px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${
                    effectiveTheme === 'dark' 
                      ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600' 
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Previous
                </button>
                
                <div className="flex items-center space-x-1">
                  <input
                    type="number"
                    min="1"
                    max={totalPages}
                    value={currentPage}
                    onChange={(e) => {
                      const page = parseInt(e.target.value);
                      if (page >= 1 && page <= totalPages) {
                        setCurrentPage(page);
                      }
                    }}
                    className={`w-16 px-2 py-1 text-sm text-center border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      effectiveTheme === 'dark' 
                        ? 'bg-gray-700 border-gray-600 text-gray-200' 
                        : 'bg-white border-slate-300 text-slate-700'
                    }`}
                  />
                  <span className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>of {totalPages}</span>
                </div>
                
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className={`px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${
                    effectiveTheme === 'dark' 
                      ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600' 
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Next
                </button>
                <button
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className={`p-1 rounded disabled:opacity-50 disabled:cursor-not-allowed ${effectiveTheme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-slate-100'}`}
                >
                  <svg className={`w-5 h-5 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}