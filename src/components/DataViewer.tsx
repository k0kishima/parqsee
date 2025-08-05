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
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
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
      <div className="h-screen bg-slate-50 p-8">
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
    <div className="h-screen flex flex-col bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 shadow-sm">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                {fileName}
              </h1>
              {metadata && (
                <p className="text-sm text-slate-600 mt-0.5">
                  {metadata.num_rows.toLocaleString()} rows × {metadata.num_columns} columns
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={loadData}
              className="inline-flex items-center px-3 py-1.5 text-sm bg-white border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 transition-colors"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
            <button
              className="inline-flex items-center px-3 py-1.5 text-sm bg-white border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 transition-colors"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Export
            </button>
            <button
              onClick={onClose}
              className="inline-flex items-center px-3 py-1.5 text-sm bg-slate-100 text-slate-700 rounded-md hover:bg-slate-200 transition-colors"
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
              <div className="text-slate-600">Loading data...</div>
            </div>
          </div>
        ) : (
          <>
            {/* Table Container */}
            <div className="flex-1 overflow-auto bg-white shadow-inner">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-slate-100 border-b border-slate-200">
                  <tr>
                    {metadata?.columns.map((col, index) => (
                      <th
                        key={index}
                        className="px-4 py-3 text-left font-medium text-slate-700 border-r border-slate-200 last:border-r-0"
                      >
                        <div className="font-semibold">{col.name}</div>
                        <div className="font-normal text-slate-500 text-xs mt-0.5">
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
                        border-b border-slate-100 cursor-pointer transition-colors
                        ${selectedRow === rowIndex 
                          ? 'bg-blue-50 hover:bg-blue-100' 
                          : 'hover:bg-slate-50'
                        }
                      `}
                    >
                      {metadata?.columns.map((col, colIndex) => (
                        <td
                          key={colIndex}
                          className="px-4 py-2.5 text-sm border-r border-slate-100 last:border-r-0"
                        >
                          {row[col.name] !== null && row[col.name] !== undefined ? (
                            <span className="text-slate-900 font-mono text-xs">{String(row[col.name])}</span>
                          ) : (
                            <span className="text-slate-400 italic font-mono text-xs">NULL</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer with Pagination */}
            <div className="bg-white border-t border-slate-200 px-6 py-3 flex items-center justify-between">
              <div className="text-sm text-slate-600">
                Showing {((currentPage - 1) * rowsPerPage) + 1} to{' '}
                {Math.min(currentPage * rowsPerPage, metadata?.num_rows || 0)} of{' '}
                {metadata?.num_rows.toLocaleString()} entries
              </div>
              
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className="p-1 rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1 text-sm bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
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
                    className="w-16 px-2 py-1 text-sm text-center border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-600">of {totalPages}</span>
                </div>
                
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1 text-sm bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
                <button
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className="p-1 rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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