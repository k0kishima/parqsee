import { invoke } from '@tauri-apps/api/core';
import type { FileEntry as ListedEntry } from '../../../bindings/ipc/FileEntry';

/** A listing entry as Rust returns it, plus what the explorer notes on it. */
export type FileEntry = ListedEntry & {
    /** Set when listing this directory failed; shown in place of children. */
    loadError?: string;
};

export const listDirectory = async (path: string): Promise<FileEntry[]> => {
    return await invoke('list_directory', { path });
};
