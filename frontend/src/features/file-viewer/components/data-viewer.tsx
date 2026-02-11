import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../contexts/SettingsContext";
import { SearchBar } from "./search-bar";
import { FilterBar } from "./filter-bar";
import { ExportModal } from "./export-modal";
import { openParquetFile, readParquetData, countParquetData, evictCache, ParquetMetadata } from "../api";
import { TabState } from "../routes/tab-content";

interface DataViewerProps {
  filePath: string;
  onClose: () => void;
  initialState?: TabState;
  onStateChange?: (state: TabState) => void;
}

function DataViewerComponent({ filePath, onClose, initialState, onStateChange }: DataViewerProps) {
  const { settings, effectiveTheme } = useSettings();
  const { t } = useTranslation();

  const [metadata, setMetadata] = useState<ParquetMetadata | null>(null);
  const [data, setData] = useState<any[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Use ref to break dependency cycle for onStateChange
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  // Initialize state from props
  const [currentPage, setCurrentPage] = useState(initialState?.currentPage || 1);
  const [selectedRow, setSelectedRow] = useState<number | null>(initialState?.selectedRow || null);
  const [isSearchOpen, setIsSearchOpen] = useState(initialState?.isSearchOpen || false);
  const [searchTerm, setSearchTerm] = useState(initialState?.searchTerm || "");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchFocusTrigger, setSearchFocusTrigger] = useState(0); // Trigger to force focus
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  // Filter state
  const [activeFilter, setActiveFilter] = useState(initialState?.activeFilter || "");

  const rowsPerPage = settings.rowsPerPage;
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Sync state changes to parent
  useEffect(() => {
    if (onStateChangeRef.current) {
      onStateChangeRef.current({
        currentPage,
        searchTerm,
        activeFilter,
        selectedRow,
        isSearchOpen,
        viewMode: 'browse',
      });
    }
  }, [currentPage, searchTerm, activeFilter, selectedRow, isSearchOpen]);

  useEffect(() => {
    loadFile();
  }, [filePath]);

  useEffect(() => {
    if (metadata) {
      loadData();
      // Scroll to top of table when page changes
      if (tableContainerRef.current) {
        tableContainerRef.current.scrollTop = 0;
      }
    }
  }, [currentPage, metadata, rowsPerPage, activeFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [rowsPerPage, activeFilter]);

  // Keyboard shortcut for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Cmd+F (Mac) or Ctrl+F (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        // Trigger focus even if search bar is already open
        setSearchFocusTrigger(prev => prev + 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadFile = async () => {
    try {
      setLoading(true);
      const meta = await openParquetFile(filePath);
      setMetadata(meta);
      setTotalRows(meta.num_rows);
      setActiveFilter("");
    } catch (err) {
      setError(err as string);
      setLoading(false);
    }
  };

  const loadData = async () => {
    if (!metadata) return;

    try {
      setLoading(true);

      // Update total rows based on filter
      if (activeFilter) {
        const count = await countParquetData(filePath, activeFilter);
        setTotalRows(count);
      } else {
        setTotalRows(metadata.num_rows);
      }

      const rows = await readParquetData(filePath, (currentPage - 1) * rowsPerPage, rowsPerPage, activeFilter);
      setData(rows);
      setLoading(false);
    } catch (err) {
      setError(err as string);
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setCurrentPage(1);
    setSearchTerm('');
    setIsSearchOpen(false);
    setMetadata(null);
    await evictCache(filePath);
    await loadFile();
  };

  const handleFilterChange = useCallback((filter: string) => {
    setActiveFilter(filter);
  }, []);

  const totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
  const fileName = filePath.split('/').pop() || filePath;

  // Optimized search functionality with early returns
  const searchMatches = useMemo(() => {
    if (!searchTerm || !metadata || !data) return [];

    const matches: Array<{ rowIndex: number; colIndex: number; value: string }> = [];
    const lowerSearchTerm = searchTerm.toLowerCase();
    const maxMatches = 1000; // Limit to prevent performance issues

    // Search in column names first (fast)
    for (let colIndex = 0; colIndex < metadata.columns.length; colIndex++) {
      const col = metadata.columns[colIndex];
      if (col.name.toLowerCase().includes(lowerSearchTerm)) {
        matches.push({ rowIndex: -1, colIndex, value: col.name });
        if (matches.length >= maxMatches) return matches;
      }
    }

    // Search in data with early exit
    outerLoop: for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
      const row = data[rowIndex];
      for (let colIndex = 0; colIndex < metadata.columns.length; colIndex++) {
        const col = metadata.columns[colIndex];
        const value = row[col.name];
        if (value !== null && value !== undefined) {
          const stringValue = String(value);
          if (stringValue.toLowerCase().includes(lowerSearchTerm)) {
            matches.push({ rowIndex, colIndex, value: stringValue });
            if (matches.length >= maxMatches) break outerLoop;
          }
        }
      }
    }

    return matches;
  }, [searchTerm, data, metadata]);

  const handleSearchSubmit = useCallback((value: string) => {
    const trimmedValue = value.trim();
    if (trimmedValue) {
      setIsSearching(true);
      setTimeout(() => {
        setSearchTerm(trimmedValue);
        setCurrentMatchIndex(0);
        setIsSearching(false);
      }, 50);
    } else {
      setSearchTerm("");
      setCurrentMatchIndex(0);
      setIsSearching(false);
    }
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
            <h2 className="text-red-800 font-semibold mb-2 text-lg">{t('viewer.error')}</h2>
            <p className="text-red-600 mb-4">{error}</p>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors shadow-sm"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const headerBg = effectiveTheme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-slate-200';


  return (
    <div className={`h-full flex flex-col relative ${effectiveTheme === 'dark' ? 'bg-gray-900' : 'bg-slate-50'}`}>
      {/* Search Bar */}
      <SearchBar
        isOpen={isSearchOpen}
        searchTerm={searchTerm}
        onSearchSubmit={handleSearchSubmit}
        onClose={() => {
          setIsSearchOpen(false);
          setSearchTerm("");
          setCurrentMatchIndex(0);
          setIsSearching(false);
        }}
        currentMatch={searchMatches.length > 0 ? currentMatchIndex + 1 : 0}
        totalMatches={searchMatches.length}
        onNext={handleNextMatch}
        onPrevious={handlePreviousMatch}
        isSearching={isSearching}
        focusTrigger={searchFocusTrigger}
      />

      {/* Header */}
      <div className={`shadow-sm border-b ${headerBg}`}>
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <div>
              <h1 className={`text-xl font-semibold ${effectiveTheme === 'dark' ? 'text-gray-100' : 'text-slate-900'}`}>
                {fileName}
              </h1>
              {metadata && (
                <p className={`text-sm mt-0.5 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>
                  {t('viewer.summary', { rows: totalRows.toLocaleString(), columns: metadata.num_columns })}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setIsSearchOpen(true)}
              className={`inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors ${effectiveTheme === 'dark'
                ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600'
                : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              title="Search (⌘F / Ctrl+F)"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {t('viewer.search')}
            </button>
            <button
              onClick={handleRefresh}
              disabled={loading}
              title="Refresh file"
              className={`inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors ${loading
                ? 'opacity-50 cursor-not-allowed'
                : ''
                } ${effectiveTheme === 'dark'
                  ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600'
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {t('viewer.refresh')}
            </button>
            <button
              onClick={() => setIsExportModalOpen(true)}
              className={`inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors ${effectiveTheme === 'dark'
                ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600'
                : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {t('viewer.export')}
            </button>

          </div>
        </div>

        {/* Filter Bar - Sequel Pro Style */}
        <FilterBar
          columns={metadata?.columns || []}
          onFilterChange={handleFilterChange}
          activeFilter={activeFilter}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
              <div className={`${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>{t('viewer.loading')}</div>
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
                        className={`px-4 py-3 text-left font-medium border-r last:border-r-0 whitespace-nowrap ${effectiveTheme === 'dark' ? 'text-gray-200 border-gray-600' : 'text-slate-700 border-slate-200'
                          } ${isColumnMatch(index) ? 'bg-yellow-100' : ''
                          }`}
                      >
                        <div className="font-semibold">
                          {searchTerm && col.name.toLowerCase().includes(searchTerm.toLowerCase())
                            ? highlightText(col.name)
                            : col.name
                          }
                        </div>
                        <div className={`font-normal text-xs mt-0.5 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-500'}`}>
                          {(() => {
                            const typeDisplay = settings.typeDisplay || 'logical';
                            if (typeDisplay === 'both' && col.logical_type) {
                              return `${col.logical_type} / ${col.physical_type.replace("PhysicalType(", "").replace(")", "")}`;
                            } else if (typeDisplay === 'physical') {
                              return col.physical_type.replace("PhysicalType(", "").replace(")", "");
                            } else {
                              return col.logical_type || col.physical_type.replace("PhysicalType(", "").replace(")", "");
                            }
                          })()}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((row, rowIndex) => {
                    const rowKey = `row-${currentPage}-${rowIndex}`;
                    return (
                      <tr
                        key={rowKey}
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
                        {metadata?.columns.map((col, colIndex) => {
                          const cellKey = `${rowKey}-${colIndex}`;
                          const cellValue = row[col.name];
                          const cellValueStr = cellValue !== null && cellValue !== undefined ? String(cellValue) : null;
                          const hasSearchMatch = searchTerm && cellValueStr && cellValueStr.toLowerCase().includes(searchTerm.toLowerCase());

                          return (
                            <td
                              key={cellKey}
                              className={`px-4 py-2.5 text-sm border-r last:border-r-0 whitespace-nowrap ${effectiveTheme === 'dark' ? 'border-gray-700' : 'border-slate-100'
                                } ${isCurrentMatch(rowIndex, colIndex)
                                  ? 'bg-orange-200'
                                  : hasSearchMatch
                                    ? 'bg-yellow-100'
                                    : ''
                                }`}
                            >
                              {cellValueStr !== null ? (
                                <span className={`font-mono text-xs ${effectiveTheme === 'dark' ? 'text-gray-200' : 'text-slate-900'}`}>
                                  {hasSearchMatch
                                    ? highlightText(cellValueStr)
                                    : cellValueStr
                                  }
                                </span>
                              ) : (
                                <span className={`italic font-mono text-xs ${effectiveTheme === 'dark' ? 'text-gray-500' : 'text-slate-400'}`}>NULL</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer with Pagination */}
            <div className={`px-6 py-3 flex items-center justify-between border-t ${effectiveTheme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-slate-200'}`}>
              <div className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>
                {t('viewer.pagination.showing', {
                  start: totalRows > 0 ? ((currentPage - 1) * rowsPerPage) + 1 : 0,
                  end: Math.min(currentPage * rowsPerPage, totalRows),
                  total: totalRows.toLocaleString()
                })}
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
                  className={`px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${effectiveTheme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                    }`}
                >
                  {t('viewer.pagination.previous')}
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
                    className={`w-16 px-2 py-1 text-sm text-center border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${effectiveTheme === 'dark'
                      ? 'bg-gray-700 border-gray-600 text-gray-200'
                      : 'bg-white border-slate-300 text-slate-700'
                      }`}
                  />
                  <span className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>{t('viewer.pagination.of', { total: totalPages })}</span>
                </div>

                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className={`px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${effectiveTheme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                    }`}
                >
                  {t('viewer.pagination.next')}
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

      {/* Export Modal */}
      {metadata && (
        <ExportModal
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          filePath={filePath}
          totalRows={metadata.num_rows}
        />
      )}
    </div>
  );
}

// Memoize DataViewer to prevent unnecessary re-renders
export const DataViewer = React.memo(DataViewerComponent);