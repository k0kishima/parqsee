import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'common.fileExplorer': 'File Explorer',
        'fileExplorer.searchPlaceholder': 'Filter files...',
        'fileExplorer.clearSearch': 'Clear search',
        'fileExplorer.contextMenu.copyPath': 'Copy Path',
        'fileExplorer.contextMenu.revealInFinder': 'Reveal in Finder',
        'fileExplorer.contextMenu.openInNewTab': 'Open in New Tab',
        'fileExplorer.breadcrumb.root': '/',
      };
      return translations[key] ?? key;
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
