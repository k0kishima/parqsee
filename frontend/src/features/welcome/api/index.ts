import { invoke } from '@tauri-apps/api/core';
import type { RecentFile } from '../../../bindings/ipc/RecentFile';

export type { RecentFile };

/** Recent Files, newest first; `available` is false for a file that cannot be reached any more. */
export const listRecentFiles = async (): Promise<RecentFile[]> => {
    return await invoke('list_recent_files');
};

/**
 * Record a file that was just opened. The backend creates its
 * security-scoped bookmark now, while the app can still read it, so the
 * entry can reopen the file after a relaunch.
 */
export const rememberFile = async (path: string): Promise<RecentFile> => {
    return await invoke('remember_file', { path });
};

export const removeRecentFile = async (path: string): Promise<void> => {
    return await invoke('remove_recent_file', { path });
};

export const clearRecentFiles = async (): Promise<void> => {
    return await invoke('clear_recent_files');
};

/**
 * The bundled sample file (`Contents/Resources/sample.parquet`), for "Open
 * sample file". Opened through the ordinary open path afterwards, minus
 * `rememberFile`: it is not one of the user's files.
 */
export const sampleFilePath = async (): Promise<string> => {
    return await invoke('sample_file_path');
};
