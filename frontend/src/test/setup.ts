import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'common.fileExplorer': 'File Explorer',
        'fileExplorer.searchPlaceholder': 'Filter files...',
        'fileExplorer.clearSearch': 'Clear search',
        'fileExplorer.contextMenu.copyPath': 'Copy Path',
        'fileExplorer.contextMenu.revealInFinder': 'Reveal in Finder',
        'fileExplorer.contextMenu.openInNewTab': 'Open',
        'fileExplorer.breadcrumb.root': '/',
        'fileExplorer.loadError': 'Cannot read this folder: {{reason}}',
      };
      const text = translations[key] ?? key;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

// Mock @tauri-apps/api/core
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/plugin-opener
vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn(),
}));
