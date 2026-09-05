import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceRoot } from '../../../bindings/ipc/WorkspaceRoot';
import type { SessionTab } from '../../../bindings/ipc/SessionTab';
import type { SessionTabs } from '../../../bindings/ipc/SessionTabs';
import type { SessionTabInput } from '../../../bindings/ipc/SessionTabInput';

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

export type { SessionTab, SessionTabs, SessionTabInput };

/**
 * The tabs of the last session, each marked available or not. Reopening
 * them is the caller's job (through `openParquetFile`, never `rememberFile`:
 * a restore must not reorder Recent Files).
 */
export const listSessionTabs = async (): Promise<SessionTabs> => {
    return await invoke('list_session_tabs');
};

/** Replace the saved session with the tabs open now; `active` is the active tab's path. */
export const saveSession = async (tabs: SessionTabInput[], active: string | null): Promise<void> => {
    return await invoke('save_session', { tabs, active });
};
