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
