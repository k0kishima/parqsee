import { invoke } from '@tauri-apps/api/core';

// Whether the webview runs inside Tauri. The API's own check
// (`@tauri-apps/api/core`), re-exported so call sites and tests keep one
// import for it.
export { isTauri } from '@tauri-apps/api/core';

/**
 * A call whose failure there is nothing to do about and nobody to tell:
 * ending a run that may already have answered, letting go of rows the
 * backend may already have dropped. What these have in common is that
 * the caller has moved on by the time it asks — often it is unmounting —
 * so a rejection has no surface left to reach, and left unhandled it
 * would become an unhandled one. The backend's own caps and the end of
 * the process collect whatever a missed call leaves behind.
 */
export async function invokeBestEffort(command: string, args?: Record<string, unknown>): Promise<void> {
  try {
    await invoke(command, args);
  } catch {
    // Deliberately silent; see above.
  }
}

/**
 * The message to show for a rejected Tauri call. Commands wrap their body in
 * `commands::guarded` and return `Result<T, String>`, so `invoke` rejects with
 * that string; anything else was thrown by the webview. Every call site used
 * to convert this itself — one asserted `err as string` and put a non-string
 * straight into React state, another replaced it with a fixed English
 * sentence — so the conversion lives here.
 */
export function toErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
