export type Theme = 'light' | 'dark' | 'system';
export type TypeDisplay = 'logical' | 'physical' | 'both';
export type Language = 'en' | 'ja';
/** Vertical padding of the grids' rows; `comfortable` is the original size. */
export type RowDensity = 'comfortable' | 'compact';

/** The cell and header classes each density gives the grids. */
export const ROW_DENSITY_CLASSES = {
  comfortable: { cell: 'py-2.5', header: 'py-3', queryCell: 'py-1.5', queryHeader: 'py-2' },
  compact: { cell: 'py-1', header: 'py-1.5', queryCell: 'py-0.5', queryHeader: 'py-1' },
} satisfies Record<RowDensity, Record<string, string>>;

export interface Settings {
  theme: Theme;
  rowsPerPage: number;
  typeDisplay: TypeDisplay;
  language: Language;
  /** Reopen the tabs of the last session at launch. */
  restoreTabs: boolean;
  rowDensity: RowDensity;
}

/**
 * The language to start in when nothing is saved yet: the one the system
 * is set to, when the app has it. A Mac set to Japanese would otherwise
 * open in English until its owner found the setting — and the native menu
 * follows this too (`set_menu_language`), so a wrong guess is visible in
 * the menu bar as well.
 *
 * `navigator.language` is the webview's own view of the preferred
 * languages, which on macOS is the system's list narrowed to the
 * localizations the bundle declares (`CFBundleLocalizations` in
 * `backend/Info.plist`). Only the primary subtag is read: `ja`, `ja-JP`
 * and `ja-Jpan-JP` are the same language to us.
 */
export function systemLanguage(): Language {
  const preferred = typeof navigator === 'undefined' ? '' : navigator.language ?? '';
  return preferred.toLowerCase().split('-')[0] === 'ja' ? 'ja' : 'en';
}

export const defaultSettings: Settings = {
  theme: 'system',
  rowsPerPage: 50,  // Reduced default for better performance
  typeDisplay: 'logical',
  language: systemLanguage(),
  restoreTabs: true,
  rowDensity: 'comfortable',
};

const SETTINGS_STORAGE_KEY = 'parqsee-settings';

/**
 * Read persisted settings merged over the defaults. Kept free of React and of
 * SettingsContext so it can also be called at import time (see lib/i18n).
 */
export function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (saved) {
      // Merge saved settings with defaults to ensure all properties exist
      return { ...defaultSettings, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error('Failed to parse saved settings', e);
  }
  return defaultSettings;
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
