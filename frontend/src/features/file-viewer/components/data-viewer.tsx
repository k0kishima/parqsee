import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useSettings } from "../../../contexts/SettingsContext";
import { ROWS_PER_PAGE_OPTIONS } from "../../../lib/settings-storage";
import { SearchBar } from "./search-bar";
import { FilterBar, type FilterBarHandle, type FilterCondition } from "./filter-bar";
import { ExportModal } from "./export-modal";
import { DataTable } from "./data-table";
import { ColumnProfilePanel } from "./column-profile";
import { ViewOptions } from "./view-options";
import { openParquetFile, readParquetData, countParquetData, evictCacheQuietly, ParquetMetadata, SortSpec } from "../api";
import { TabState } from "../routes/tab-content";
import { getFileName } from "../../../lib/path";
import { findSearchMatches } from "../lib/search";
import { pageWindow } from "../lib/page-window";
import { loadFailure, type LoadedState } from "../lib/load-failure";
import { isSortableColumn, nextSort } from "../lib/sort";
import type { RowData } from "../../../lib/row";
import { useAppCommand, type AppCommand } from "../../../lib/app-commands";
import { toErrorMessage } from "../../../lib/tauri";
import { withShortcut } from "../../../lib/shortcuts";

interface DataViewerProps {
  filePath: string;
  onClose: () => void;
  initialState?: TabState;
  onStateChange?: (state: TabState) => void;
  /**
   * True while this grid is the visible view. Every tab's viewer stays
   * mounted and listens for shortcuts; without this, ⌘F in a hidden viewer
   * — or in the SQL view of the same tab — opened its search bar.
   */
  isActiveRef?: RefObject<boolean>;
  /**
   * Where the file's actions (row count, search, refresh, export) go: the
   * tab's toolbar, on the row of the Content / Query switch, so the grid
   * starts right under the filter bar instead of under a title bar that
   * repeated the tab's name. `null` is a host that has not mounted yet
   * (nothing is rendered, so the actions never flash in place first);
   * `undefined` is no host at all, and they render in place.
   */
  toolbarSlot?: HTMLElement | null;
  /**
   * Called once after this viewer is unmounted, when the last backend call
   * that was already in flight by then settles. A read cannot be taken
   * back: it lands, and the backend re-creates the file's session and
   * re-takes its access grant on the way. The tab that would have evicted
   * them is gone, so whoever is handed this evicts them instead — unless
   * the file has a tab again.
   */
  onAbandonedLoad?: () => void;
}

const EMPTY_COLUMNS: ParquetMetadata['columns'] = [];

/**
 * What the banner over the grid says. `kept` is the ordinary failure: the
 * rows of the last good load are still on screen. `dropped` is the first
 * load of a file that refused the filter or the sort it was asked for —
 * the plain page is on screen instead, so the banner has to name the
 * condition that is no longer applied; the filter bar cannot, having gone
 * back to an empty row with it.
 *
 * `condition` says whether the request that failed was a filter or a sort
 * the user had just asked for. Only then is a condition what could not be
 * run: a page move, and a read the backend refused because the file was
 * replaced under the tab, carry no condition at all, and heading those
 * with one sends the reader to a filter bar that has nothing wrong with
 * it.
 */
type DataProblem =
  | { kind: 'kept'; condition: boolean; message: string }
  | { kind: 'dropped'; message: string; filter: string };

/** The line above the backend's own message in the banner. */
function problemHeadline(problem: DataProblem): string {
  if (problem.kind === 'dropped') return 'viewer.filterDropped';
  return problem.condition ? 'viewer.dataError' : 'viewer.loadError';
}

function DataViewerComponent({ filePath, onClose, initialState, onStateChange, isActiveRef, toolbarSlot, onAbandonedLoad }: DataViewerProps) {
  const { settings, updateSettings } = useSettings();
  const { t } = useTranslation();

  const [metadata, setMetadata] = useState<ParquetMetadata | null>(null);
  const [data, setData] = useState<RowData[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(true);
  /** Fatal: the file itself could not be opened. */
  const [error, setError] = useState<string | null>(null);
  /** Recoverable: a filter or a page read failed; the tab stays usable. */
  const [dataError, setDataError] = useState<DataProblem | null>(null);

  // Use ref to break dependency cycle for onStateChange
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  const onAbandonedLoadRef = useRef(onAbandonedLoad);
  useEffect(() => {
    onAbandonedLoadRef.current = onAbandonedLoad;
  }, [onAbandonedLoad]);

  /**
   * True once this viewer is gone — the tab was closed, on its own or with
   * a group. A call already sent cannot be cancelled, but the next call of
   * the sequence can be left unsent, which is what keeps a closed tab from
   * paging a file nothing shows. `loadSeq` does not answer this: nothing
   * advances it on unmount, so a load in flight still looks like the
   * newest one.
   */
  const unmounted = useRef(false);
  /** Backend calls started here and not yet settled. */
  const inFlight = useRef(0);
  // Cleared on the way in as well as set on the way out: StrictMode mounts,
  // unmounts and mounts again in development, and a flag that is only ever
  // set left the remounted viewer believing it was closed — it dropped its
  // own first load and the grid never left its spinner.
  useEffect(() => {
    unmounted.current = false;
    return () => { unmounted.current = true; };
  }, []);

  /**
   * Run one backend call, counting it so that an unmount can tell when the
   * last call it could not cancel has settled — the moment the session and
   * the access grant that call re-created are there with no tab left to
   * evict them.
   */
  const track = useCallback(async <T,>(call: Promise<T>): Promise<T> => {
    inFlight.current += 1;
    try {
      return await call;
    } finally {
      inFlight.current -= 1;
      if (unmounted.current && inFlight.current === 0) onAbandonedLoadRef.current?.();
    }
  }, []);

  // Initialize state from props
  const [currentPage, setCurrentPage] = useState(initialState?.currentPage || 1);
  // Never restored from initialState: the reset below always ran on mount.
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(initialState?.isSearchOpen || false);
  const [searchTerm, setSearchTerm] = useState(initialState?.searchTerm || "");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [searchFocusTrigger, setSearchFocusTrigger] = useState(0); // Trigger to force focus
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  // Filter state
  const [activeFilter, setActiveFilter] = useState(initialState?.activeFilter || "");
  const filterBarRef = useRef<FilterBarHandle>(null);

  // The column the grid is sorted by, from the header's sort button; null
  // is file order. Part of the tab's saved state, like the filter.
  const [sort, setSort] = useState<SortSpec | null>(initialState?.sort ?? null);

  // The column whose profile panel is open. Not part of the tab's saved
  // state: like the search, it is a look at the file, not a view of it.
  const [profiledColumn, setProfiledColumn] = useState<string | null>(null);

  // Local state for page input (Enter key / blur to confirm)
  const [pageInput, setPageInput] = useState(String(currentPage));

  // Sync pageInput when currentPage changes externally (e.g., Previous/Next
  // buttons). Adjusted during render from the previous page rather than in
  // an effect (react.dev/learn/you-might-not-need-an-effect).
  const [inputPage, setInputPage] = useState(currentPage);
  if (inputPage !== currentPage) {
    setInputPage(currentPage);
    setPageInput(String(currentPage));
  }

  const rowsPerPage = settings.rowsPerPage;
  const tableContainerRef = useRef<HTMLDivElement>(null);
  /**
   * How far right the grid was scrolled when the load started. The table is
   * replaced by the spinner while a page loads, so the scroller that comes
   * back is a new element at the left edge; this is what it is put back to.
   */
  const savedScrollLeft = useRef(0);
  /** Remember the column the grid is on before the spinner takes it away. */
  const saveScrollLeft = useCallback(() => {
    savedScrollLeft.current = tableContainerRef.current?.scrollLeft ?? savedScrollLeft.current;
  }, []);

  /** The state the rows on screen were successfully loaded for. */
  const lastGood = useRef<LoadedState | null>(null);
  /** Skip the reload triggered by rolling state back after a failed load. */
  const skipReload = useRef(false);
  /**
   * Carry the banner through the next load instead of clearing it at the
   * start, as every other load does. Dropping a refused filter starts the
   * plain load itself, and its success is exactly when the user has to be
   * told why the condition is gone.
   */
  const keepBanner = useRef(false);
  /**
   * Sequence number of the latest load. Loads resolve in arrival order, not
   * request order — a cleared filter answered before the slow filtered count
   * it superseded, and the filtered rows then overwrote the unfiltered grid.
   * Only the newest request may commit.
   */
  const loadSeq = useRef(0);

  // Sync state changes to parent. The view mode is the tab's to decide;
  // writing 'browse' from here pulled the user out of the SQL view whenever
  // this state changed.
  useEffect(() => {
    if (onStateChangeRef.current) {
      onStateChangeRef.current({
        currentPage,
        searchTerm,
        activeFilter,
        sort,
        selectedRow,
        isSearchOpen,
      });
    }
  }, [currentPage, searchTerm, activeFilter, sort, selectedRow, isSearchOpen]);

  const loadFile = useCallback(async () => {
    // Page loads still in flight belong to the previous metadata.
    const seq = ++loadSeq.current;
    saveScrollLeft();
    try {
      setLoading(true);
      setError(null);
      setDataError(null);
      lastGood.current = null;
      const meta = await track(openParquetFile(filePath));
      if (unmounted.current) return;
      if (seq !== loadSeq.current) return;
      setMetadata(meta);
      setTotalRows(meta.num_rows);
      // A sort follows the file's columns: restored from a session, or kept
      // across a Refresh, it may name a column the file no longer has, and
      // the grid is better in file order than on an error screen.
      setSort(s => (s && meta.columns.some(c => c.name === s.column && isSortableColumn(c)) ? s : null));
      // The filter is kept across a refresh: dropping it here left the filter
      // bar showing a condition the grid no longer applied. If the file's
      // columns changed underneath it, the reload below fails, drops the
      // condition, reads the plain page instead and leaves the reason in a
      // banner — a rewritten file must not cost the tab.
    } catch (err) {
      if (unmounted.current) return;
      if (seq !== loadSeq.current) return;
      setError(toErrorMessage(err));
      setLoading(false);
    }
  }, [filePath, track, saveScrollLeft]);

  const loadData = useCallback(async () => {
    if (!metadata) return;
    const seq = ++loadSeq.current;
    saveScrollLeft();

    try {
      setLoading(true);
      if (!keepBanner.current) setDataError(null);
      keepBanner.current = false;

      const total = activeFilter
        ? await track(countParquetData(filePath, activeFilter))
        : metadata.num_rows;
      // The tab was closed while COUNT was running: the page it would read
      // next is for no one, and reading it would leave the backend holding
      // the file again.
      if (unmounted.current) return;
      // A newer filter/Refresh may have finished while COUNT was running.
      // Do not start an expensive page sort for an obsolete request.
      if (seq !== loadSeq.current) return;
      const { offset, limit } = pageWindow(currentPage, rowsPerPage, total);
      const rows = await track(readParquetData(filePath, offset, limit, activeFilter, sort));
      if (unmounted.current) return;
      // A newer load has taken over; its result describes the current state.
      if (seq !== loadSeq.current) return;

      // Commit only once the whole read succeeded, so the header, the export
      // modal and the grid always describe the same result — a count that
      // lands before a failing read must not update the page.
      setTotalRows(total);
      setData(rows);
      lastGood.current = { page: currentPage, filter: activeFilter, sort, totalRows: total };
      setLoading(false);
    } catch (err) {
      if (unmounted.current) return;
      if (seq !== loadSeq.current) return;
      const outcome = loadFailure(lastGood.current, { page: currentPage, filter: activeFilter, sort });
      if (outcome.kind === 'file') {
        setError(toErrorMessage(err));
        setLoading(false);
        return;
      }
      if (outcome.kind === 'retryPlain') {
        // No rows have ever been on screen, so there is nothing to roll
        // back to: the condition goes and the plain page is read in its
        // place. `skipReload` is deliberately not set — the reload this
        // state change starts is the point of it.
        setDataError({ kind: 'dropped', message: toErrorMessage(err), filter: activeFilter });
        keepBanner.current = true;
        setActiveFilter('');
        setSort(null);
        setCurrentPage(1);
        setLoading(false);
        return;
      }
      // The page alone moving is not a condition; the filter and the sort
      // are compared against the load that is still on screen.
      const condition = outcome.restore.filter !== activeFilter || outcome.restore.sort !== sort;
      setDataError({ kind: 'kept', condition, message: toErrorMessage(err) });
      if (outcome.rewinds) {
        skipReload.current = true;
        setActiveFilter(outcome.restore.filter);
        setCurrentPage(outcome.restore.page);
        setSort(outcome.restore.sort);
      }
      setTotalRows(outcome.restore.totalRows);
      setLoading(false);
    }
  }, [filePath, metadata, activeFilter, currentPage, rowsPerPage, sort, track, saveScrollLeft]);

  // filePath is fixed for a mounted viewer (TabContent is keyed by tab), so
  // loadFile only ever changes with it and loadData with the page state the
  // effect below used to list itself.
  useEffect(() => {
    loadFile();
  }, [loadFile]);

  useEffect(() => {
    if (metadata) {
      if (skipReload.current) {
        skipReload.current = false;
        return;
      }
      loadData();
      // Scroll to top of table when page changes
      if (tableContainerRef.current) {
        tableContainerRef.current.scrollTop = 0;
      }
    }
  }, [metadata, loadData]);

  // Put the grid back on the column it was on. The vertical position is
  // reset on purpose above — a new page starts at its top — but the
  // horizontal one only went missing with the scroller: a sort clicked on
  // the last of six hundred columns scrolled the grid away from the very
  // column it sorted, its `aria-sort` mark included. `loading` is a
  // dependency because that is when the element is swapped: the table is
  // unmounted for the spinner and mounted again afterwards, so the ref
  // holds the new scroller only once `loading` is false again. Before the
  // browser paints, so the left edge is never on screen; assigning
  // `scrollLeft` fires a scroll event, which is how the column
  // virtualizer learns which columns to render, and a position past a
  // narrower table's width is clamped by the browser.
  useLayoutEffect(() => {
    const scroller = tableContainerRef.current;
    if (scroller && !loading) scroller.scrollLeft = savedScrollLeft.current;
  }, [loading, data]);

  // A new page size from the settings starts over from the first page; the
  // footer select resets the page itself, in the same event. Skipped on mount
  // so a restored page survives.
  // Adjusted during render, not in an effect
  // (react.dev/learn/you-might-not-need-an-effect).
  const [loadedRowsPerPage, setLoadedRowsPerPage] = useState(rowsPerPage);
  if (loadedRowsPerPage !== rowsPerPage) {
    setLoadedRowsPerPage(rowsPerPage);
    setCurrentPage(1);
  }

  const searchMatches = useMemo(
    () => (metadata ? findSearchMatches(searchTerm, metadata.columns, data) : []),
    [searchTerm, data, metadata]
  );

  // The matches are the ones on the page, so a page, filter or sort change
  // replaces the list under the walk: the sixth match of a page of seven has
  // no counterpart on a page of three. The walk starts over at the first
  // match of the rows that arrived. Adjusted during render from the rows the
  // index was counted for, not in an effect
  // (react.dev/learn/you-might-not-need-an-effect).
  const [matchedRows, setMatchedRows] = useState(data);
  if (matchedRows !== data) {
    setMatchedRows(data);
    setCurrentMatchIndex(0);
  }
  /**
   * The match the counter names and the grid highlights. Clamped rather than
   * read straight out of the list: the index is only reset when the rows
   * change, and a list that shrinks under the same rows would leave it past
   * the end, with a count of nothing highlighted.
   */
  const activeMatchIndex = currentMatchIndex < searchMatches.length ? currentMatchIndex : 0;

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

  // ⌘F / ⌘G / ⇧⌘G, from the native menu or the workspace's keydown
  // fallback (see lib/app-commands.ts). Next / previous work wherever the
  // focus is while the search is open, as in Safari; they used to need the
  // search box focused.
  useAppCommand(useCallback((command: AppCommand) => {
    if (isActiveRef && !isActiveRef.current) return;
    switch (command) {
      case 'find':
        setIsSearchOpen(true);
        // Focus the box even when the bar is already open
        setSearchFocusTrigger(prev => prev + 1);
        break;
      case 'find-next':
        if (isSearchOpen) handleNextMatch();
        break;
      case 'find-previous':
        if (isSearchOpen) handlePreviousMatch();
        break;
    }
  }, [isActiveRef, isSearchOpen, handleNextMatch, handlePreviousMatch]));

  const handleRefresh = async () => {
    setCurrentPage(1);
    setSearchTerm('');
    setIsSearchOpen(false);
    setMetadata(null);
    await track(evictCacheQuietly(filePath));
    if (unmounted.current) return;
    await loadFile();
  };

  // A selected row is a row of the page on screen; keeping its index across
  // a page or filter change highlighted an unrelated row. Cleared during
  // render when the page identity changes, not in an effect
  // (react.dev/learn/you-might-not-need-an-effect).
  const pageIdentity = `${currentPage} ${rowsPerPage} ${activeFilter} ${sort ? `${sort.direction} ${sort.column}` : ''}`;
  const [selectedPageIdentity, setSelectedPageIdentity] = useState(pageIdentity);
  if (selectedPageIdentity !== pageIdentity) {
    setSelectedPageIdentity(pageIdentity);
    setSelectedRow(null);
  }

  const handleFilterChange = useCallback((filter: string) => {
    setActiveFilter(filter);
    // A new filter changes the row set; start from the first page. Done here
    // rather than in an effect so rolling activeFilter back after a failed
    // load does not also reset the page.
    setCurrentPage(1);
  }, []);

  // A click on a header sorts by that column, the next reverses it, the
  // third returns to file order (`nextSort`). The sequence changes, so the
  // grid starts over from the first page, as after a filter.
  const handleSort = useCallback((column: string) => {
    setSort(current => nextSort(current, column));
    setCurrentPage(1);
  }, []);

  // A second click on the column's button closes its panel.
  const handleProfileColumn = useCallback((name: string) => {
    setProfiledColumn(current => (current === name ? null : name));
  }, []);
  const closeProfile = useCallback(() => setProfiledColumn(null), []);
  const handleAddConditions = useCallback((conditions: FilterCondition[]) => {
    filterBarRef.current?.addConditions(conditions);
  }, []);
  // The panel follows the metadata: a Refresh that dropped the column
  // closes it.
  const profileColumn = metadata?.columns.find(c => c.name === profiledColumn) ?? null;

  const totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
  const shownRows = pageWindow(currentPage, rowsPerPage, totalRows);
  const fileName = getFileName(filePath);

  const commitPageInput = useCallback(() => {
    const page = parseInt(pageInput, 10);
    if (!isNaN(page) && page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    } else {
      setPageInput(String(currentPage));
    }
  }, [pageInput, totalPages, currentPage]);

  // Applied in the same event as the Enter that asked for it. The search is
  // a pass over the rows already on screen, so the 50 ms delay this used to
  // take bought nothing and outlived the bar: an Escape within it closed the
  // search and cleared the term, and the term then came back with no bar
  // left to clear it again — the highlights stayed, and the tab was saved
  // with a closed search still holding a term.
  const handleSearchSubmit = useCallback((value: string) => {
    setSearchTerm(value.trim());
    setCurrentMatchIndex(0);
  }, []);

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

  const actionButton = 'inline-flex items-center px-3 py-1.5 text-sm border rounded-md transition-colors bg-white border-secondary text-slate-700 hover:bg-slate-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600';
  const whileLoading = loading ? 'opacity-50 cursor-not-allowed' : '';

  const actions = (
    <>
      {metadata && (
        <span className="text-xs whitespace-nowrap truncate text-slate-500 dark:text-gray-400">
          {t('viewer.summary', { rows: totalRows.toLocaleString(), columns: metadata.num_columns })}
        </span>
      )}
      {/* Inline, so an open search never covers the buttons beside it. */}
      <SearchBar
        isOpen={isSearchOpen}
        searchTerm={searchTerm}
        onSearchSubmit={handleSearchSubmit}
        onClose={() => {
          setIsSearchOpen(false);
          setSearchTerm("");
          setCurrentMatchIndex(0);
        }}
        currentMatch={searchMatches.length > 0 ? activeMatchIndex + 1 : 0}
        totalMatches={searchMatches.length}
        onNext={handleNextMatch}
        onPrevious={handlePreviousMatch}
        // A reopened tab comes back with its search running (the counter and
        // the highlights are on screen), so the box has to hold the term it
        // is running on: an Enter on an empty box would clear it.
        initialValue={searchTerm}
        focusTrigger={searchFocusTrigger}
      />
      <ViewOptions buttonClassName={`${actionButton} px-2`} />
      <button
        onClick={() => setIsSearchOpen(true)}
        className={actionButton}
        title={withShortcut(t('viewer.search'), 'find')}
      >
        <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        {t('viewer.search')}
      </button>
      <button
        onClick={handleRefresh}
        disabled={loading}
        title={t('viewer.refresh')}
        className={`${actionButton} ${whileLoading}`}
      >
        <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {t('viewer.refresh')}
      </button>
      <button
        onClick={() => setIsExportModalOpen(true)}
        disabled={loading}
        className={`${actionButton} ${whileLoading}`}
      >
        <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {t('viewer.export')}
      </button>
    </>
  );

  return (
    <div className="h-full flex flex-col relative bg-slate-50 dark:bg-gray-900">
      {/* The visible name is the tab's; this one is for assistive technology. */}
      <h1 className="sr-only">{fileName}</h1>
      {toolbarSlot === undefined ? (
        <div className="px-2 py-1 flex items-center justify-end gap-2 border-b bg-white border-primary dark:bg-gray-800">
          {actions}
        </div>
      ) : toolbarSlot && createPortal(actions, toolbarSlot)}

      {/* Filter Bar - Sequel Pro Style */}
      <div className="shadow-sm border-b border-primary">
        <FilterBar
          ref={filterBarRef}
          columns={metadata?.columns || []}
          onFilterChange={handleFilterChange}
          activeFilter={activeFilter}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {dataError && (
          <div className="px-6 py-2 flex items-start gap-3 border-b bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-900">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-800 dark:text-red-300">
                {t(problemHeadline(dataError))}
              </p>
              <p className="text-xs font-mono break-words text-red-600 dark:text-red-400">{dataError.message}</p>
              {dataError.kind === 'dropped' && dataError.filter && (
                <p className="text-xs font-mono break-words text-red-600 dark:text-red-400">{dataError.filter}</p>
              )}
            </div>
            <button
              onClick={() => setDataError(null)}
              title={t('common.dismiss')}
              className="p-1 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-900/40"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {/* The grid and, beside it, the column profile. The panel sits
            outside the loading branch: a filter change reloads the grid
            and re-profiles the column, and the panel keeps its place
            while both are in flight. */}
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col">
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
                  <div className="text-slate-600 dark:text-gray-400">{t('viewer.loading')}</div>
                </div>
              </div>
            ) : (
              <DataTable
                columns={metadata?.columns ?? EMPTY_COLUMNS}
                rows={data}
                selectedRow={selectedRow}
                onSelectRow={setSelectedRow}
                searchTerm={searchTerm}
                searchMatches={searchMatches}
                currentMatchIndex={activeMatchIndex}
                typeDisplay={settings.typeDisplay || 'logical'}
                density={settings.rowDensity}
                scrollerRef={tableContainerRef}
                profiledColumn={profiledColumn}
                onProfileColumn={handleProfileColumn}
                sort={sort}
                onSort={handleSort}
              />
            )}
          </div>
          {profileColumn && (
            <ColumnProfilePanel
              filePath={filePath}
              column={profileColumn}
              filter={activeFilter}
              onClose={closeProfile}
              onAddConditions={handleAddConditions}
            />
          )}
        </div>
        {!loading && (
          <>
            {/* Footer with Pagination */}
            <div className="px-6 py-3 flex items-center justify-between border-t bg-white border-primary dark:bg-gray-800">
              <div className="flex items-center space-x-3">
                <div className="flex items-center space-x-1.5">
                  <select
                    value={rowsPerPage}
                    onChange={(e) => {
                      // Reset the page in the same event as the size change,
                      // so the grid loads once instead of the old page at the
                      // new size followed by the first page.
                      setLoadedRowsPerPage(Number(e.target.value));
                      setCurrentPage(1);
                      updateSettings({ rowsPerPage: Number(e.target.value) });
                    }}
                    className="px-2 py-1 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white border-secondary text-slate-700 dark:bg-gray-700 dark:text-gray-200"
                  >
                    {ROWS_PER_PAGE_OPTIONS.map((value) => (
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
                    start: shownRows.startRow,
                    end: shownRows.endRow,
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
                  className="px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed bg-white border-secondary text-slate-700 hover:bg-slate-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
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
                    className="w-16 px-2 py-1 text-sm text-center border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white border-secondary text-slate-700 dark:bg-gray-700 dark:text-gray-200"
                  />
                  <span className="text-sm text-slate-600 dark:text-gray-400">{t('viewer.pagination.of', { total: totalPages })}</span>
                </div>

                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1 text-sm border rounded-md disabled:opacity-50 disabled:cursor-not-allowed bg-white border-secondary text-slate-700 hover:bg-slate-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
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
          totalRows={totalRows}
          activeFilter={activeFilter}
          sort={sort}
          currentPage={currentPage}
          rowsPerPage={rowsPerPage}
        />
      )}
    </div>
  );
}

// Memoize DataViewer to prevent unnecessary re-renders
export const DataViewer = React.memo(DataViewerComponent);
