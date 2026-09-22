import { invokeBestEffort } from './tauri';

/**
 * Naming a profile request, and ending one the panel has stopped waiting
 * for. Both panels use this: the column profile of a file and of a query
 * result are the same panel, and the backend cancels either by id.
 *
 * A profile is a scan whose `COUNT(DISTINCT)` reserves its hash table out
 * of the file session's memory pool, and nothing used to stop the scan
 * behind a panel that had moved on — on a large file the abandoned one
 * could leave the profile on screen with no memory to finish in. So the
 * panel says when it no longer wants an answer, rather than the backend
 * guessing which request replaces which: two tabs of one file each have a
 * panel of their own.
 */

let issued = 0;

/** An id no other request of this session carries. */
export function nextProfileRequestId(): string {
  issued += 1;
  return `profile-${Date.now().toString(36)}-${issued.toString(36)}`;
}

/**
 * Stop the profile `requestId` names, best effort. An id that has already
 * answered is nothing to cancel, and a caller that is unmounting has
 * nowhere to report a failure to.
 */
export const cancelProfile = (requestId: string): Promise<void> =>
  invokeBestEffort('cancel_profile', { requestId });
