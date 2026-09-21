import { invoke } from '@tauri-apps/api/core';
import type { ColumnProfile } from '../../../bindings/ipc/ColumnProfile';

/**
 * The profile of one column of a kept result, over the rows `filter`
 * keeps. The column is named by position: two columns of one result may
 * share a name, and an expression's name is not an identifier.
 */
export const profileQueryColumn = (
  resultId: string,
  columnIndex: number,
  filter?: string,
  requestId?: string,
): Promise<ColumnProfile> => invoke('profile_query_column', { resultId, columnIndex, filter, requestId });

/** The rows of a kept result that `filter` keeps, keyed as the grid renders them. */
export const filterQueryResult = (
  resultId: string,
  filter?: string,
): Promise<Record<string, unknown>[]> => invoke('filter_query_result', { resultId, filter });

/**
 * Let go of a result: a re-run replaced it, a superseded run's answer
 * arrived anyway, or the tab holding it closed. Failing is not worth
 * reporting — the store's caps collect what a missed call leaves.
 */
export async function releaseQueryResult(resultId: string): Promise<void> {
  try {
    await invoke('release_query_result', { resultId });
  } catch {
    // Nothing to do and nobody to tell: the rows are the backend's, and
    // its caps collect a result no call ever released.
  }
}
