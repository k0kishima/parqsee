import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../contexts/SettingsContext";
import { SearchBar } from "./search-bar";
import { FilterBar } from "./filter-bar";
import { ExportModal } from "./export-modal";
import { DataTable, SearchMatch } from "./data-table";
import { openParquetFile, readParquetData, countParquetData, evictCache, ParquetMetadata } from "../api";
import { TabState } from "../routes/tab-content";
import { getFileName } from "../../../lib/path";
import { useGlobalKeydown, isModifierPressed } from "../../../hooks/useGlobalKeydown";

interface DataViewerProps {
  filePath: string;
  onClose: () => void;
  initialState?: TabState;
  onStateChange?: (state: TabState) => void;
}

const EMPTY_COLUMNS: ParquetMetadata['columns'] = [];

function DataViewerComponent({ filePath, onClose, initialState, onStateChange }: DataViewerProps) {
  const { settings, updateSettings } = useSettings();
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

  // Local state for page input (Enter key / blur to confirm)
  const [pageInput, setPageInput] = useState(String(currentPage));

  // Sync pageInput when currentPage changes externally (e.g., Previous/Next buttons)
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

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
  useGlobalKeydown(useCallback((e: KeyboardEvent) => {
    // Check for Cmd+F (Mac) or Ctrl+F (Windows/Linux)
    if (isModifierPressed(e) && e.key === 'f') {
      e.preventDefault();
      setIsSearchOpen(true);
      // Trigger focus even if search bar is already open
      setSearchFocusTrigger(prev => prev + 1);
    }
  }, []));

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
  const fileName = getFileName(filePath);

  const commitPageInput = useCallback(() => {
    const page = parseInt(pageInput, 10);
    if (!isNaN(page) && page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    } else {
      setPageInput(String(currentPage));
    }
  }, [pageInput, totalPages, currentPage]);

  // Optimized search functionality with early returns
  const searchMatches = useMemo(() => {
    if (!searchTerm || !metadata || !data) return [];

    const matches: SearchMatch[] = [];
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


  const handleNextMatch = useCallback(() => {
    if (searchMatches.length > 0) {
      setCurrentMatchIndex(i => (i + 1) % searchMatches.length);
    }
  }, [searchMatches]);

  const handlePreviousMatch = useCallback(() => {
    if (searchMatches.length > 0) {
      setCurrentMatchIndex(i => (i === 0 ? searchMatches.length - 1 : i - 1));
    }
  }, [searchMatches]);

  if (error) {
    return (
      <div className="h-full p-8 bg-slate-50 dark:bg-gray-900">
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

  const headerBg = 'bg-white border-slate-200 dark:bg-gray-800 dark:border-gray-700';


  return (
    <div className="h-full flex flex-col relative bg-slate-50 dark:bg-gray-900">
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
              <h1 className="text-xl font-semibold text-slate-900 dark:text-gray-100">
                {fileName}
              </h1>
              {metadata && (
                <p className="text-sm mt-0.5 text-slate-600 dark:text-gray-400">
                  {t('viewer.summary', { rows: totalRows.toLocaleString(), columns: metadata.num_columns })}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setIsSearchOpen(true)}
              className="inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors bg-white border-slate-300 text-slate-700 hover:bg-slate-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-600"
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
                } bg-white border-slate-300 text-slate-700 hover:bg-slate-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-600`}
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {t('viewer.refresh')}
            </button>
            <button
              onClick={() => setIsExportModalOpen(true)}
              className="inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors bg-white border-slate-300 text-slate-700 hover:bg-slate-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-600"
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
              <div className="text-slate-600 dark:text-gray-400">{t('viewer.loading')}</div>
            </div>
          </div>
        ) : (
          <>
            {/* Table Container */}
            <DataTable
              columns={metadata?.columns ?? EMPTY_COLUMNS}
              rows={data}
              selectedRow={selectedRow}
              onSelectRow={setSelectedRow}
              searchTerm={searchTerm}
              searchMatches={searchMatches}
              currentMatchIndex={currentMatchIndex}
              typeDisplay={settings.typeDisplay || 'logical'}
              scrollerRef={tableContainerRef}
            />

            {/* Footer with Pagination */}
            <div className="px-6 py-3 flex items-center justify-between border-t bg-white border-slate-200 dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-1.5">
                  <select
                    value={rowsPerPage}
                    onChange={(e) => updateSettings({ rowsPerPage: Number(e.target.value) })}
                    className="px-2 py-1 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white border-slate-300 text-slate-700 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
                  >
                    {[25, 50, 100, 200, 500].map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                  <span className="text-sm text-slate-600 dark:text-gray-400">
                    {t('viewer.pagination.rowsPerPage')}
                  </span>
                </div>
                <span className="text-sm text-slate-300 dark:text-gray-600">|</span>
                <div className="text-sm text-slate-600 dark:text-gray-400">
                  {t('viewer.pagination.showing', {
                    start: totalRows > 0 ? ((currentPage - 1) * rowsPerPage) + 1 : 0,
                    end: Math.min(currentPage * rowsPerPage, totalRows),
                    total: totalRows.toLocaleString()
                  })}
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className="p-1 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-gray-700"
                >
                  <svg className="w-5 h-5 text-slate-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed bg-white border-slate-300 text-slate-700 hover:bg-slate-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-600"
                >
                  {t('viewer.pagination.previous')}
                </button>

                <div className="flex items-center space-x-1">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={pageInput}
                    onChange={(e) => {
                      setPageInput(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        commitPageInput();
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={() => {
                      commitPageInput();
                    }}
                    className="w-16 px-2 py-1 text-sm text-center border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white border-slate-300 text-slate-700 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
                  />
                  <span className="text-sm text-slate-600 dark:text-gray-400">{t('viewer.pagination.of', { total: totalPages })}</span>
                </div>

                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed bg-white border-slate-300 text-slate-700 hover:bg-slate-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-600"
                >
                  {t('viewer.pagination.next')}
                </button>
                <button
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className="p-1 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-gray-700"
                >
                  <svg className="w-5 h-5 text-slate-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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