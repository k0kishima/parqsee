import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { exportData } from "../api";
import { getFileName, stripParquetExtension } from "../../../lib/path";
import { ExportRange, resolveExportRange } from "../lib/export-range";
import { pageWindow } from "../lib/page-window";
import { toErrorMessage } from "../../../lib/tauri";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string;
  /** Rows matching the active filter — what the grid is paginating over. */
  totalRows: number;
  activeFilter: string;
  currentPage: number;
  rowsPerPage: number;
}

export function ExportModal({
  isOpen,
  onClose,
  filePath,
  totalRows,
  activeFilter,
  currentPage,
  rowsPerPage,
}: ExportModalProps) {
  const { t } = useTranslation();
  const [exportFormat, setExportFormat] = useState<"csv" | "json">("csv");
  const [exportRange, setExportRange] = useState<ExportRange>("all");
  // Kept as the typed text: clamping on every keystroke made a cleared field
  // snap back to 1 (or to the last row) before the next digit, so a range
  // could not be typed in.
  const [startInput, setStartInput] = useState("1");
  const [endInput, setEndInput] = useState(String(totalRows));
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The finished export, shown in the modal itself — an OS notification may
   * never be delivered (permission denied, unsigned build), and then a
   * silently closing modal was the only sign anything had happened. */
  const [done, setDone] = useState<{ rows: number; path: string } | null>(null);
  /** Copy Path acknowledges the click by relabelling itself for a moment. */
  const [copied, setCopied] = useState(false);

  // The row count moves with the filter, so start from the full range every
  // time the modal is opened rather than from the last export's bounds.
  // totalRows is deliberately not a dependency: a count landing while the
  // modal is open must not clobber a range the user is editing.
  useEffect(() => {
    if (isOpen) {
      setStartInput("1");
      setEndInput(String(totalRows));
      setError(null);
      setDone(null);
      setCopied(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Esc closes the modal, unless an export is running.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isExporting) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, isExporting, onClose]);

  // Revert the "Copied" label; the timer must not outlive a closed modal.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!isOpen) return null;

  const hasRows = totalRows > 0;
  const { startRow: pageStart, endRow: pageEnd } = pageWindow(currentPage, rowsPerPage, totalRows);
  // The window the backend will export, or null while the custom bounds
  // do not describe one.
  const exportWindow = resolveExportRange(exportRange, { totalRows, currentPage, rowsPerPage, startInput, endInput });
  const rangeIsValid = exportWindow !== null;
  const canExport = hasRows && rangeIsValid && !isExporting;

  const handleExport = async () => {
    if (!exportWindow) return;
    setError(null);
    setIsExporting(true);

    try {
      // Determine file extension based on format
      const extensions = {
        csv: ["csv"],
        json: ["json"]
      };

      // Get default filename from parquet file
      const originalFileName = getFileName(filePath);
      const baseFileName = stripParquetExtension(originalFileName);
      const defaultFileName = `${baseFileName}.${exportFormat}`;

      // Open save dialog
      const savePath = await save({
        defaultPath: defaultFileName,
        filters: [{
          name: `${exportFormat.toUpperCase()} files`,
          extensions: extensions[exportFormat]
        }]
      });

      if (!savePath) {
        setIsExporting(false);
        return;
      }

      // Call the export command
      const exportedRows = await exportData({
        sourcePath: filePath,
        exportPath: savePath,
        format: exportFormat,
        ...exportWindow,
        // Ranges address the filtered result, so the backend has to apply the
        // same condition the grid is showing.
        filter: activeFilter || undefined
      });

      setDone({ rows: exportedRows, path: savePath });

      // Also notify, for an export long enough to have left the window.
      const fileName = getFileName(savePath);
      await sendNotification({
        title: t('export.success.title'),
        body: t('export.success.body', {
          rows: exportedRows.toLocaleString(),
          file: fileName
        }),
        icon: "done"
      });
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setIsExporting(false);
    }
  };

  // Same approach as the explorer context menu (context-menu.tsx).
  const handleCopyPath = async () => {
    if (!done) return;
    try {
      await navigator.clipboard.writeText(done.path);
      setCopied(true);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  if (done) {
    return (
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
        onClick={onClose}
      >
        <div
          className="rounded-lg shadow-xl w-96 bg-white dark:bg-gray-800"
          role="dialog"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('export.success.title')}
            </h2>
          </div>
          <div className="px-6 py-4 space-y-2">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('export.success.body', { rows: done.rows.toLocaleString(), file: getFileName(done.path) })}
            </p>
            <p className="text-xs font-mono break-all text-gray-500 dark:text-gray-400">{done.path}</p>
          </div>
          <div className="px-6 py-4 border-t flex justify-end space-x-3 border-gray-200 dark:border-gray-700">
            <button
              onClick={handleCopyPath}
              className="btn-secondary border border-gray-300 dark:border-gray-600"
            >
              {copied ? t('export.success.copied') : t('fileExplorer.contextMenu.copyPath')}
            </button>
            <button
              onClick={() => revealItemInDir(done.path).catch((err) => console.error('Failed to reveal in Finder:', err))}
              className="btn-secondary border border-gray-300 dark:border-gray-600"
            >
              {t('fileExplorer.contextMenu.revealInFinder')}
            </button>
            <button onClick={onClose} className="btn-primary">
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={() => { if (!isExporting) onClose(); }}
    >
      <div
        className="rounded-lg shadow-xl w-96 bg-white dark:bg-gray-800"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('export.title')}
          </h2>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Format Selection */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-200">
              {t('export.format')}
            </label>
            <div className="space-y-2">
              <label className="flex items-center">
                <input
                  type="radio"
                  value="csv"
                  checked={exportFormat === "csv"}
                  onChange={(e) => setExportFormat(e.target.value as "csv")}
                  className="mr-2"
                />
                <span className="text-gray-700 dark:text-gray-300">
                  {t('export.formats.csv')}
                </span>
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  value="json"
                  checked={exportFormat === "json"}
                  onChange={(e) => setExportFormat(e.target.value as "json")}
                  className="mr-2"
                />
                <span className="text-gray-700 dark:text-gray-300">
                  {t('export.formats.json')}
                </span>
              </label>
            </div>
          </div>

          {/* Range Selection */}
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-200">
              {t('export.range')}
            </label>
            {activeFilter && (
              <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                {t('export.filterNotice')}
                <span className="ml-1 font-mono break-all">{activeFilter}</span>
              </p>
            )}
            <div className="space-y-2">
              <label className="flex items-center">
                <input
                  type="radio"
                  value="all"
                  checked={exportRange === "all"}
                  onChange={() => setExportRange("all")}
                  className="mr-2"
                />
                <span className="text-gray-700 dark:text-gray-300">
                  {t('export.ranges.all', { total: totalRows.toLocaleString() })}
                </span>
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  value="current"
                  checked={exportRange === "current"}
                  onChange={() => setExportRange("current")}
                  className="mr-2"
                />
                <span className="text-gray-700 dark:text-gray-300">
                  {t('export.ranges.current', { start: pageStart.toLocaleString(), end: pageEnd.toLocaleString() })}
                </span>
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  value="custom"
                  checked={exportRange === "custom"}
                  onChange={() => setExportRange("custom")}
                  className="mr-2"
                />
                <span className="text-gray-700 dark:text-gray-300">
                  {t('export.ranges.custom')}
                </span>
              </label>
            </div>
          </div>

          {/* Custom Range Inputs */}
          {exportRange === "custom" && (
            <div className="flex items-center space-x-2">
              <div className="flex-1">
                <label className="block text-xs mb-1 text-gray-600 dark:text-gray-400">
                  {t('export.startRow')}
                </label>
                <input
                  type="number"
                  min="1"
                  max={totalRows}
                  value={startInput}
                  onChange={(e) => setStartInput(e.target.value)}
                  className="w-full px-3 py-1 border rounded-md text-sm bg-white border-gray-300 text-gray-700 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs mb-1 text-gray-600 dark:text-gray-400">
                  {t('export.endRow')}
                </label>
                <input
                  type="number"
                  min="1"
                  max={totalRows}
                  value={endInput}
                  onChange={(e) => setEndInput(e.target.value)}
                  className="w-full px-3 py-1 border rounded-md text-sm bg-white border-gray-300 text-gray-700 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
                />
              </div>
            </div>
          )}

          {!hasRows && (
            <p className="text-sm text-amber-700 dark:text-amber-400">{t('export.noRows')}</p>
          )}
          {hasRows && !rangeIsValid && (
            <p className="text-sm text-red-600">{t('export.invalidRange', { total: totalRows.toLocaleString() })}</p>
          )}

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t flex justify-end space-x-3 border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            disabled={isExporting}
            className={`btn-secondary border border-gray-300 dark:border-gray-600 ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleExport}
            disabled={!canExport}
            className={`btn-primary ${!canExport ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isExporting ? t('export.exporting') : t('common.export')}
          </button>
        </div>
      </div>
    </div>
  );
}