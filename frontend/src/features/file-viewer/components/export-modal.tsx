import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { useSettings } from "../../../contexts/SettingsContext";
import { exportData } from "../api";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string;
  totalRows: number;
}

export function ExportModal({ isOpen, onClose, filePath, totalRows }: ExportModalProps) {
  const { effectiveTheme } = useSettings();
  const [exportFormat, setExportFormat] = useState<"csv" | "json">("csv");
  const [exportRange, setExportRange] = useState<"all" | "current" | "custom">("all");
  const [startRow, setStartRow] = useState(1);
  const [endRow, setEndRow] = useState(totalRows);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleExport = async () => {
    setError(null);
    setIsExporting(true);

    try {
      // Determine file extension based on format
      const extensions = {
        csv: ["csv"],
        json: ["json"]
      };

      // Get default filename from parquet file
      const originalFileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'export';
      const baseFileName = originalFileName.replace(/\.parquet$/i, '');
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

      // Calculate offset and limit based on export range
      let offset: number | undefined;
      let limit: number | undefined;

      if (exportRange === "custom") {
        offset = startRow - 1;
        limit = endRow - startRow + 1;
      } else if (exportRange === "all") {
        // Export all rows
        offset = undefined;
        limit = undefined;
      }

      // Call the export command
      const result = await exportData({
        sourcePath: filePath,
        exportPath: savePath,
        format: exportFormat,
        offset,
        limit
      });

      console.log(result);

      // Send notification
      const fileName = savePath.split('/').pop() || savePath.split('\\').pop() || savePath;
      await sendNotification({
        title: "Export Complete",
        body: `Successfully exported to ${fileName}`,
        icon: "done"
      });

      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div
        className={`rounded-lg shadow-xl w-96 ${effectiveTheme === 'dark' ? 'bg-gray-800' : 'bg-white'
          }`}
      >
        <div className={`px-6 py-4 border-b ${effectiveTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
          }`}>
          <h2 className={`text-lg font-semibold ${effectiveTheme === 'dark' ? 'text-gray-100' : 'text-gray-900'
            }`}>
            Export Data
          </h2>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Format Selection */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${effectiveTheme === 'dark' ? 'text-gray-200' : 'text-gray-700'
              }`}>
              Export Format
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
                <span className={effectiveTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'}>
                  CSV (Comma-separated values)
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
                <span className={effectiveTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'}>
                  JSON (JavaScript Object Notation)
                </span>
              </label>
            </div>
          </div>

          {/* Range Selection */}
          <div>
            <label className={`block text-sm font-medium mb-2 ${effectiveTheme === 'dark' ? 'text-gray-200' : 'text-gray-700'
              }`}>
              Export Range
            </label>
            <div className="space-y-2">
              <label className="flex items-center">
                <input
                  type="radio"
                  value="all"
                  checked={exportRange === "all"}
                  onChange={(e) => setExportRange(e.target.value as "all")}
                  className="mr-2"
                />
                <span className={effectiveTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'}>
                  All rows ({totalRows.toLocaleString()} rows)
                </span>
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  value="custom"
                  checked={exportRange === "custom"}
                  onChange={(e) => setExportRange(e.target.value as "custom")}
                  className="mr-2"
                />
                <span className={effectiveTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'}>
                  Custom range
                </span>
              </label>
            </div>
          </div>

          {/* Custom Range Inputs */}
          {exportRange === "custom" && (
            <div className="flex items-center space-x-2">
              <div className="flex-1">
                <label className={`block text-xs mb-1 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                  Start Row
                </label>
                <input
                  type="number"
                  min="1"
                  max={totalRows}
                  value={startRow}
                  onChange={(e) => setStartRow(Math.max(1, parseInt(e.target.value) || 1))}
                  className={`w-full px-3 py-1 border rounded-md text-sm ${effectiveTheme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-gray-200'
                    : 'bg-white border-gray-300 text-gray-700'
                    }`}
                />
              </div>
              <div className="flex-1">
                <label className={`block text-xs mb-1 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                  End Row
                </label>
                <input
                  type="number"
                  min="1"
                  max={totalRows}
                  value={endRow}
                  onChange={(e) => setEndRow(Math.min(totalRows, parseInt(e.target.value) || totalRows))}
                  className={`w-full px-3 py-1 border rounded-md text-sm ${effectiveTheme === 'dark'
                    ? 'bg-gray-700 border-gray-600 text-gray-200'
                    : 'bg-white border-gray-300 text-gray-700'
                    }`}
                />
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}
        </div>

        <div className={`px-6 py-4 border-t flex justify-end space-x-3 ${effectiveTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'
          }`}>
          <button
            onClick={onClose}
            disabled={isExporting}
            className={`px-4 py-2 text-sm border rounded-md ${effectiveTheme === 'dark'
              ? 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600'
              : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              } ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting}
            className={`px-4 py-2 text-sm text-white rounded-md ${isExporting
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700'
              }`}
          >
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}