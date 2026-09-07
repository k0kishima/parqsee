import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import i18n from '../lib/i18n';
import { Settings, loadSettings, saveSettings } from '../lib/settings-storage';
import { setMenuLanguage } from '../features/settings/api';

export type { Settings };

interface SettingsContextType {
  settings: Settings;
  updateSettings: (newSettings: Partial<Settings>) => void;
  effectiveTheme: 'light' | 'dark';
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>('light');

  // Sync the language into i18n, which draws the webview, and into the
  // native menu, which Rust draws (`set_menu_language`). The menu is
  // already in the system's language by the time this first runs, so the
  // usual call changes nothing and the backend does nothing.
  useEffect(() => {
    if (i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language);
    }
    setMenuLanguage(settings.language).catch(error =>
      console.error('Failed to set the menu language:', error)
    );
  }, [settings.language]);

  useEffect(() => {
    // Save settings to localStorage when they change
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    // Determine effective theme
    const updateTheme = () => {
      if (settings.theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        setEffectiveTheme(isDark ? 'dark' : 'light');
      } else {
        setEffectiveTheme(settings.theme);
      }
    };

    updateTheme();

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', updateTheme);

    return () => mediaQuery.removeEventListener('change', updateTheme);
  }, [settings.theme]);

  useEffect(() => {
    // Apply theme to document
    if (effectiveTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [effectiveTheme]);

  const updateSettings = (newSettings: Partial<Settings>) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, effectiveTheme }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}