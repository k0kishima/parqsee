import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { exportData, exportDefaultDir } from "../api";
import { getFileName, stripParquetExtension } from "../../../lib/path";
import { ExportRange, resolveExportRange } from "../lib/export-range";
import { pageWindow } from "../lib/page-window";
import { toErrorMessage } from "../../../lib/tauri";
import { Modal, ModalHeader } from "../../../components/modal";

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
  // Adjusted during render from the previous value of isOpen, not in an
  // effect (react.dev/learn/you-might-not-need-an-effect).
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setStartInput("1");
      setEndInput(String(totalRows));
      setError(null);
      setDone(null);
      setCopied(false);
    }
  }

  // Revert the "Copied" label; the timer must not outlive a closed modal.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!isOpen) return null;

  // Escape, the backdrop, ✕ and Cancel all close it — unless an export is running.
  const close = () => { if (!isExporting) onClose(); };

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

      // Where the panel starts is a nicety: if the backend cannot say,
      // the panel opens wherever it likes and the export goes ahead.
      const defaultDir = await exportDefaultDir(filePath).catch((err) => {
        console.error('Failed to resolve the export folder:', err);
        return null;
      });
      const defaultPath = defaultDir ? `${defaultDir}/${defaultFileName}` : defaultFileName;

      // Open save dialog. Under the sandbox the panel grants write access
      // to whatever the user picks; defaultPath only chooses the start.
      const savePath = await save({
        defaultPath,
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
      <Modal onClose={onClose} labelledBy="export-done-title" panelClassName="max-w-md">
        <ModalHeader id="export-done-title" title={t('export.success.title')} onClose={onClose} />
        <div className="px-6 py-4 space-y-2">
          <p className="text-sm text-secondary">
            {t('export.success.body', { rows: done.rows.toLocaleString(), file: getFileName(done.path) })}
          </p>
          <p className="text-xs font-mono break-all text-tertiary">{done.path}</p>
        </div>
        <div className="px-6 py-4 border-t border-primary flex justify-end space-x-3">
          <button onClick={handleCopyPath} className="btn-secondary">
            {copied ? t('export.success.copied') : t('fileExplorer.contextMenu.copyPath')}
          </button>
          <button
            onClick={() => revealItemInDir(done.path).catch((err) => console.error('Failed to reveal in Finder:', err))}
            className="btn-secondary"
          >
            {t('fileExplorer.contextMenu.revealInFinder')}
          </button>
          <button onClick={onClose} className="btn-primary">
            {t('common.close')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={close} labelledBy="export-title" panelClassName="max-w-md">
      <ModalHeader id="export-title" title={t('export.title')} onClose={close} />

      <div className="px-6 py-4 space-y-4">
        {/* Format Selection */}
        <div>
          <label className="block text-sm font-medium mb-2 text-primary">
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
              <span className="text-secondary">
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
              <span className="text-secondary">
                {t('export.formats.json')}
              </span>
            </label>
          </div>
        </div>

        {/* Range Selection */}
        <div>
          <label className="block text-sm font-medium mb-2 text-primary">
            {t('export.range')}
          </label>
          {activeFilter && (
            <p className="mb-2 text-xs text-tertiary">
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
              <span className="text-secondary">
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
              <span className="text-secondary">
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
              <span className="text-secondary">
                {t('export.ranges.custom')}
              </span>
            </label>
          </div>
        </div>

        {/* Custom Range Inputs */}
        {exportRange === "custom" && (
          <div className="flex items-center space-x-2">
            <div className="flex-1">
              <label className="block text-xs mb-1 text-tertiary">
                {t('export.startRow')}
              </label>
              <input
                type="number"
                min="1"
                max={totalRows}
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                className="w-full px-3 py-1 border border-primary rounded-md text-sm bg-primary text-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs mb-1 text-tertiary">
                {t('export.endRow')}
              </label>
              <input
                type="number"
                min="1"
                max={totalRows}
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                className="w-full px-3 py-1 border border-primary rounded-md text-sm bg-primary text-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        )}

        {!hasRows && (
          <p className="text-sm text-amber-600 dark:text-amber-400">{t('export.noRows')}</p>
        )}
        {hasRows && !rangeIsValid && (
          <p className="text-sm text-red-600 dark:text-red-400">{t('export.invalidRange', { total: totalRows.toLocaleString() })}</p>
        )}

        {/* Error Message */}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="px-6 py-4 border-t border-primary flex justify-end space-x-3">
        <button
          onClick={onClose}
          disabled={isExporting}
          className={`btn-secondary ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
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
    </Modal>
  );
}