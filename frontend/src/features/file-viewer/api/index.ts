import { invoke } from '@tauri-apps/api/core';

export interface ColumnInfo {
    name: string;
    column_type: string;
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
    offset?: number;
    limit?: number;
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

export const readParquetData = async (path: string, offset: number, limit: number, filter?: string): Promise<any[]> => {
    return await invoke('read_parquet_data', { path, offset, limit, filter });
};

export const countParquetData = async (path: string, filter?: string): Promise<number> => {
    return await invoke('count_parquet_data', { path, filter });
};

export const exportData = async (params: ExportDataParams): Promise<string> => {
    return await invoke('export_data', params as any);
};
