import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

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
  const [metadata, setMetadata] = useState<ParquetMetadata | null>(null);
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 100;

  useEffect(() => {
    loadFile();
  }, [filePath]);

  useEffect(() => {
    if (metadata) {
      loadData();
    }
  }, [currentPage, metadata]);

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

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <h2 className="text-red-800 dark:text-red-200 font-semibold mb-2">Error Loading File</h2>
            <p className="text-red-600 dark:text-red-300">{error}</p>
            <button
              onClick={onClose}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm">
        <div className="px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-200">
              {fileName}
            </h1>
            {metadata && (
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {metadata.num_rows.toLocaleString()} rows × {metadata.num_columns} columns
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            ✕ Close
          </button>
        </div>
      </div>

      {/* Data Table */}
      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-gray-600 dark:text-gray-400">Loading data...</div>
          </div>
        ) : (
          <>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      {metadata?.columns.map((col, index) => (
                        <th
                          key={index}
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          <div>{col.name}</div>
                          <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
                            {col.column_type}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {data.map((row, rowIndex) => (
                      <tr key={rowIndex} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                        {metadata?.columns.map((col, colIndex) => (
                          <td
                            key={colIndex}
                            className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100"
                          >
                            {row[col.name] !== null && row[col.name] !== undefined
                              ? String(row[col.name])
                              : <span className="text-gray-400 dark:text-gray-600">null</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination */}
            <div className="mt-6 flex items-center justify-between">
              <div className="text-sm text-gray-600 dark:text-gray-400">
                Showing {((currentPage - 1) * rowsPerPage) + 1} to{' '}
                {Math.min(currentPage * rowsPerPage, metadata?.num_rows || 0)} of{' '}
                {metadata?.num_rows.toLocaleString()} rows
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}