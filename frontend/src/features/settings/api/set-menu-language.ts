import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../../lib/tauri';
import type { Language } from '../../../lib/settings-storage';

/**
 * Put the native menu into the UI's language.
 *
 * The menu bar is the one surface the webview cannot draw, so its labels
 * live in Rust (`services::menu_labels`) and it starts in the system's
 * language; this is how it hears about the setting. Called once the
 * settings are loaded and on every change — the backend ignores a call
 * that changes nothing, which is what launch usually is.
 *
 * A plain browser has no menu and no backend: the e2e harness and vitest
 * would only see a rejected `invoke`.
 */
export async function setMenuLanguage(language: Language): Promise<void> {
    if (!isTauri()) return;
    await invoke('set_menu_language', { language });
}
