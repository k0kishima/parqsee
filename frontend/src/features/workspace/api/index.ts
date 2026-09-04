import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceRoot } from '../../../bindings/ipc/WorkspaceRoot';

export type { WorkspaceRoot };

export const listWorkspaceRoots = async (): Promise<WorkspaceRoot[]> => {
    return await invoke('list_workspace_roots');
};

/** Open `path` as a workspace root; the backend bookmarks it for the next launch. */
export const addWorkspaceRoot = async (path: string): Promise<WorkspaceRoot> => {
    return await invoke('add_workspace_root', { path });
};

export const removeWorkspaceRoot = async (path: string): Promise<void> => {
    return await invoke('remove_workspace_root', { path });
};
