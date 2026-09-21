/**
 * Each setting's values as one list, the way ROWS_PER_PAGE_OPTIONS already
 * was: the type is read off the list, `loadSettings` validates against it,
 * and the pickers offer it. A value set otherwise gets spelled three times
 * — the union, the whitelist that keeps saved JSON honest, and the picker's
 * options — and only the first two are in the same file, so adding a theme
 * or a density in two of the three is the natural mistake.
 */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = typeof THEMES[number];

export const TYPE_DISPLAYS = ['logical', 'physical', 'both'] as const;
export type TypeDisplay = typeof TYPE_DISPLAYS[number];

export const LANGUAGES = ['en', 'ja'] as const;
export type Language = typeof LANGUAGES[number];

/** Vertical padding of the grids' rows; `comfortable` is the original size. */
export const ROW_DENSITIES = ['comfortable', 'compact'] as const;
export type RowDensity = typeof ROW_DENSITIES[number];

/** Supported page sizes, shared by persisted settings and the picker. */
export const ROWS_PER_PAGE_OPTIONS = [25, 50, 100, 200, 500] as const;

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
 * Read persisted settings, replacing invalid fields with their defaults.
 * Kept free of React and SettingsContext so it can also be called at import
 * time (see lib/i18n).
 */
export function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultSettings;
      const values = parsed as Record<string, unknown>;
      // Persisted JSON is untrusted at runtime: TypeScript's Settings type
      // cannot prevent null or obsolete values from reaching the render tree.
      return {
        theme: choice(values.theme, THEMES, defaultSettings.theme),
        rowsPerPage: choice(values.rowsPerPage, ROWS_PER_PAGE_OPTIONS, defaultSettings.rowsPerPage),
        typeDisplay: choice(values.typeDisplay, TYPE_DISPLAYS, defaultSettings.typeDisplay),
        language: choice(values.language, LANGUAGES, defaultSettings.language),
        restoreTabs: typeof values.restoreTabs === 'boolean' ? values.restoreTabs : defaultSettings.restoreTabs,
        rowDensity: choice(values.rowDensity, ROW_DENSITIES, defaultSettings.rowDensity),
      };
    }
  } catch (e) {
    console.error('Failed to parse saved settings', e);
  }
  return defaultSettings;
}

function choice<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find(option => option === value) ?? fallback;
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
