import { invoke } from '@tauri-apps/api/core';
import type { RowData } from '../../../lib/row';

/** Structural classification of a column, independent of its display label. */
export type ColumnKind =
    | 'boolean'
    | 'integer'
    | 'float'
    | 'decimal'
    | 'text'
    | 'temporal'
    | 'binary'
    | 'nested'
    | 'other';

export interface ColumnInfo {
    name: string;
    column_type: string;
    kind: ColumnKind;
    logical_type?: string;
    physical_type: string;
}

export interface ParquetMetadata {
    num_rows: number;
    num_columns: number;
    columns: ColumnInfo[];
}

export interface FileInfo {
    path: string;
    name: string;
    size: number;
}

export interface ExportDataParams {
    sourcePath: string;
    exportPath: string;
    format: 'csv' | 'json';
    /** Row range within the filtered result, not within the file. */
    offset?: number;
    limit?: number;
    /** The WHERE fragment the grid is showing, if any. */
    filter?: string;
}

export const checkFileExists = async (path: string): Promise<boolean> => {
    return await invoke('check_file_exists', { path });
};

export const openParquetFile = async (path: string): Promise<ParquetMetadata> => {
    return await invoke('open_parquet_file', { path });
};

export const getFileInfo = async (path: string): Promise<FileInfo> => {
    return await invoke('get_file_info', { path });
};

export const readParquetData = async (path: string, offset: number, limit: number, filter?: string): Promise<RowData[]> => {
    return await invoke('read_parquet_data', { path, offset, limit, filter });
};

export const countParquetData = async (path: string, filter?: string): Promise<number> => {
    return await invoke('count_parquet_data', { path, filter });
};

export const evictCache = async (path: string): Promise<void> => {
    return await invoke('evict_cache', { path });
};

/**
 * Drop the cached session, best effort. A caller that is closing a tab or
 * refreshing a file must carry on either way: left unhandled, the rejection
 * stranded the tab on an empty grid with no error.
 */
export const evictCacheQuietly = async (path: string): Promise<void> => {
    return await evictCache(path).catch(err => console.error('Failed to evict cache:', err));
};

/** Resolves with the number of rows written. */
export const exportData = async (params: ExportDataParams): Promise<number> => {
    return await invoke('export_data', params as any);
};
