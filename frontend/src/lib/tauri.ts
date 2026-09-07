// Whether the webview runs inside Tauri. The API's own check
// (`@tauri-apps/api/core`), re-exported so call sites and tests keep one
// import for it.
export { isTauri } from '@tauri-apps/api/core';

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
