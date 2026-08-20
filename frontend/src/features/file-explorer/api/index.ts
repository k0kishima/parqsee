import { invoke } from '@tauri-apps/api/core';

export interface FileEntry {
    path: string;
    name: string;
    is_directory: boolean;
    is_parquet: boolean;
    size?: number;
    children?: FileEntry[];
    /** Set when listing this directory failed; shown in place of children. */
    loadError?: string;
}

export const listDirectory = async (path: string): Promise<FileEntry[]> => {
    return await invoke('list_directory', { path });
};
