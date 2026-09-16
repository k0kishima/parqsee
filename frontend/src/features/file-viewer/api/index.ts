import { invoke } from '@tauri-apps/api/core';
import type { RowData } from '../../../lib/row';
import type { ColumnInfo } from '../../../bindings/ipc/ColumnInfo';
import type { ColumnKind } from '../../../bindings/ipc/ColumnKind';
import type { FileInfo } from '../../../bindings/ipc/FileInfo';
import type { ParquetMetadata } from '../../../bindings/ipc/ParquetMetadata';
import type { ColumnProfile } from '../../../bindings/ipc/ColumnProfile';
import type { ProfileChart } from '../../../bindings/ipc/ProfileChart';
import type { ValueCount } from '../../../bindings/ipc/ValueCount';
import type { HistogramBucket } from '../../../bindings/ipc/HistogramBucket';

export type { ColumnInfo, ColumnKind, FileInfo, ParquetMetadata, ColumnProfile, ProfileChart, ValueCount, HistogramBucket };

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

/**
 * What `column` holds under `filter` (the grid's WHERE fragment): counts and
 * a chart of its values. A scan of the file on the backend; ask when the
 * profile panel is open, not when a file is.
 */
export const profileColumn = async (path: string, column: string, filter?: string): Promise<ColumnProfile> => {
    return await invoke('profile_column', { path, column, filter });
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

/**
 * The folder the save panel for an export of `sourcePath` should start in:
 * the file's own folder inside an open workspace root, else the last export
 * folder, else null for the panel's default.
 */
export const exportDefaultDir = async (sourcePath: string): Promise<string | null> => {
    return (await invoke<string | null>('export_default_dir', { sourcePath })) ?? null;
};
