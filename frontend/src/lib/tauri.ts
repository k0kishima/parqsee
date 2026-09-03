// The original call sites also checked `typeof open === 'function'` or
// `typeof listen === 'function'`, but each referenced a different Tauri API
// import, making it unsuitable for a shared helper. Checking for __TAURI__ or
// __TAURI_INTERNALS__ on the window object is sufficient to detect the Tauri
// runtime environment.
export function isTauri(): boolean {
  return !!(
    (window as any).__TAURI__ ||
    (window as any).__TAURI_INTERNALS__
  );
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
