/**
 * The explorer sidebar's width, a per-machine convenience kept in
 * localStorage like the settings (not in `Settings`: the Settings modal
 * saves a snapshot of the whole object, and a drag while it is open would
 * be lost on Save).
 */
export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 180;
/** Absolute cap; the sidebar is also kept to half the window. */
export const MAX_SIDEBAR_WIDTH = 640;

const STORAGE_KEY = 'parqsee-sidebar-width';

export function clampSidebarWidth(width: number, windowWidth: number = window.innerWidth): number {
  const max = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(windowWidth / 2)));
  return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function loadSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) return clampSidebarWidth(saved);
  } catch {
    // No storage (or a blocked one): the default.
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export function saveSidebarWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Best effort.
  }
}
