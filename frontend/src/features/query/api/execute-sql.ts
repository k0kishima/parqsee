import { invoke } from '@tauri-apps/api/core';
import { QueryResult } from '../types';

let issued = 0;

/** An id no other run of this session carries: what `cancelQuery` ends a run by. */
export function nextQueryRequestId(): string {
    issued += 1;
    return `query-${Date.now().toString(36)}-${issued.toString(36)}`;
}

export const executeSql = async (filePath: string, query: string, requestId?: string): Promise<QueryResult> => {
    return await invoke('execute_sql', { filePath, query, requestId });
};

/**
 * Stop the run `requestId` names, best effort. A run that has already
 * answered is nothing to cancel, and the view that asked has moved on to
 * another run or to nothing — it has nowhere to report a refusal.
 */
export async function cancelQuery(requestId: string): Promise<void> {
    try {
        await invoke('cancel_query', { requestId });
    } catch {
        // The run ends with the process at the latest.
    }
}
