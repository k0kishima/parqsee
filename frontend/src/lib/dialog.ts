import { confirm as nativeConfirm } from '@tauri-apps/plugin-dialog';
import { isTauri } from './tauri';

/**
 * Ask before a destructive action; resolves to whether the user agreed.
 *
 * Never call `window.confirm` in this app. The dialog plugin's init
 * script replaces it with an `async` function that shows the native
 * OK / Cancel panel — so it returns a Promise, which is truthy whichever
 * button is pressed, and `if (confirm(...))` runs the action on Cancel
 * (the bug Clear all shipped with). Under Tauri this goes to the plugin
 * directly; in a plain browser (vitest, the e2e harness, where the init
 * script never ran) `window.confirm` is still the synchronous original.
 */
export async function confirmDestructive(message: string): Promise<boolean> {
  if (isTauri()) return nativeConfirm(message, { kind: 'warning' });
  return window.confirm(message);
}
