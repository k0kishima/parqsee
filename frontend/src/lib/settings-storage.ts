export type Theme = 'light' | 'dark' | 'system';
export type TypeDisplay = 'logical' | 'physical' | 'both';
export type Language = 'en' | 'ja';

export interface Settings {
  theme: Theme;
  rowsPerPage: number;
  showRecentFiles: boolean;
  typeDisplay: TypeDisplay;
  language: Language;
}

export const defaultSettings: Settings = {
  theme: 'system',
  rowsPerPage: 50,  // Reduced default for better performance
  showRecentFiles: true,
  typeDisplay: 'logical',
  language: 'en'
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
