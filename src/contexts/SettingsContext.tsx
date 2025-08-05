import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface Settings {
  theme: Theme;
  rowsPerPage: number;
  showRecentFiles: boolean;
}

interface SettingsContextType {
  settings: Settings;
  updateSettings: (newSettings: Partial<Settings>) => void;
  effectiveTheme: 'light' | 'dark';
}

const defaultSettings: Settings = {
  theme: 'system',
  rowsPerPage: 100,
  showRecentFiles: true
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => {
    const saved = localStorage.getItem('parqsee-settings');
    if (saved) {
      // Merge saved settings with defaults to ensure all properties exist
      const parsedSettings = JSON.parse(saved);
      return { ...defaultSettings, ...parsedSettings };
    }
    return defaultSettings;
  });

  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    // Save settings to localStorage when they change
    localStorage.setItem('parqsee-settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    // Determine effective theme
    const updateTheme = () => {
      console.log('Settings theme:', settings.theme);
      if (settings.theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        console.log('System prefers dark:', isDark);
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
    console.log('Applying theme:', effectiveTheme);
    if (effectiveTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    console.log('HTML classes:', document.documentElement.className);
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