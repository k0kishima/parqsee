import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../../contexts/SettingsContext';
import { useRecentFiles } from '../../../contexts/RecentFilesContext';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSettings } = useSettings();
  const { clearRecentFiles } = useRecentFiles();
  const [localSettings, setLocalSettings] = useState(settings);
  const { t } = useTranslation();

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  const handleSave = () => {
    console.log('Saving settings:', localSettings);
    updateSettings(localSettings);
    onClose();
  };

  const handleCancel = () => {
    setLocalSettings(settings);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
        onClick={handleCancel}
      />

      {/* Modal */}
      <div className="fixed inset-x-0 bottom-0 z-50 transform transition-transform duration-300">
        <div className="bg-primary rounded-t-2xl shadow-2xl max-w-2xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-primary">
            <h2 className="text-lg font-semibold text-primary">
              {t('settings.title')}
            </h2>
            <button
              onClick={handleCancel}
              className="p-2 hover:bg-tertiary rounded-lg transition-colors"
            >
              <svg className="w-5 h-5 text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-6 space-y-6 max-h-[60vh] overflow-y-auto">

            {/* Language Setting */}
            <div>
              <label className="block text-sm font-medium text-secondary mb-2">
                {t('settings.language')}
              </label>
              <div className="relative">
                <select
                  value={localSettings.language}
                  onChange={(e) => setLocalSettings({ ...localSettings, language: e.target.value as 'en' | 'ja' })}
                  className="w-full appearance-none px-4 py-2.5 text-sm border border-primary rounded-lg bg-primary text-primary focus:outline-none focus:ring-2 focus:ring-blue-500 hover:border-secondary transition-colors cursor-pointer"
                >
                  <option value="en">English (US)</option>
                  <option value="ja">日本語</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-secondary">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
              <p className="mt-2 text-xs text-tertiary">
                {t('settings.languageDesc')}
              </p>
            </div>

            {/* Theme Setting */}
            <div>
              <label className="block text-sm font-medium text-secondary mb-2">
                {t('settings.theme')}
              </label>
              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={() => setLocalSettings({ ...localSettings, theme: 'light' })}
                  className={`
                    flex flex-col items-center p-4 rounded-lg border-2 transition-all
                    ${localSettings.theme === 'light'
                      ? 'border-blue-500 bg-selected'
                      : 'border-primary hover:border-secondary'
                    }
                  `}
                >
                  <svg className="w-6 h-6 mb-2 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                  <span className="text-sm font-medium text-primary">{t('settings.themeOptions.light')}</span>
                </button>

                <button
                  onClick={() => setLocalSettings({ ...localSettings, theme: 'dark' })}
                  className={`
                    flex flex-col items-center p-4 rounded-lg border-2 transition-all
                    ${localSettings.theme === 'dark'
                      ? 'border-blue-500 bg-selected'
                      : 'border-primary hover:border-secondary'
                    }
                  `}
                >
                  <svg className="w-6 h-6 mb-2 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                  <span className="text-sm font-medium text-primary">{t('settings.themeOptions.dark')}</span>
                </button>

                <button
                  onClick={() => setLocalSettings({ ...localSettings, theme: 'system' })}
                  className={`
                    flex flex-col items-center p-4 rounded-lg border-2 transition-all
                    ${localSettings.theme === 'system'
                      ? 'border-blue-500 bg-selected'
                      : 'border-primary hover:border-secondary'
                    }
                  `}
                >
                  <svg className="w-6 h-6 mb-2 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <span className="text-sm font-medium text-primary">{t('settings.themeOptions.system')}</span>
                </button>
              </div>
            </div>

            {/* Rows Per Page Setting */}
            <div>
              <label className="block text-sm font-medium text-secondary mb-2">
                {t('settings.rowsPerPage')}
              </label>
              <div className="flex items-center space-x-4">
                <input
                  type="range"
                  min="10"
                  max="500"
                  step="10"
                  value={localSettings.rowsPerPage}
                  onChange={(e) => setLocalSettings({ ...localSettings, rowsPerPage: parseInt(e.target.value) })}
                  className="flex-1"
                />
                <div className="w-20">
                  <input
                    type="number"
                    min="10"
                    max="500"
                    step="10"
                    value={localSettings.rowsPerPage}
                    onChange={(e) => {
                      const value = parseInt(e.target.value);
                      if (!isNaN(value) && value >= 10 && value <= 500) {
                        setLocalSettings({ ...localSettings, rowsPerPage: value });
                      }
                    }}
                    className="w-full px-3 py-1.5 text-sm border border-primary rounded-md bg-primary text-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <p className="mt-2 text-xs text-tertiary">
                {t('settings.rowsPerPageDesc')}
              </p>
            </div>

            {/* Type Display Setting */}
            <div>
              <label className="block text-sm font-medium text-secondary mb-2">
                {t('settings.typeDisplay')}
              </label>
              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={() => setLocalSettings({ ...localSettings, typeDisplay: 'logical' })}
                  className={`
                    flex flex-col items-center p-4 rounded-lg border-2 transition-all
                    ${localSettings.typeDisplay === 'logical'
                      ? 'border-blue-500 bg-selected'
                      : 'border-primary hover:border-secondary'
                    }
                  `}
                >
                  <span className="text-xs font-mono mb-1 text-primary">DATE</span>
                  <span className="text-sm font-medium text-primary">{t('settings.typeDisplayOptions.logical')}</span>
                </button>

                <button
                  onClick={() => setLocalSettings({ ...localSettings, typeDisplay: 'physical' })}
                  className={`
                    flex flex-col items-center p-4 rounded-lg border-2 transition-all
                    ${localSettings.typeDisplay === 'physical'
                      ? 'border-blue-500 bg-selected'
                      : 'border-primary hover:border-secondary'
                    }
                  `}
                >
                  <span className="text-xs font-mono mb-1 text-primary">INT32</span>
                  <span className="text-sm font-medium text-primary">{t('settings.typeDisplayOptions.physical')}</span>
                </button>

                <button
                  onClick={() => setLocalSettings({ ...localSettings, typeDisplay: 'both' })}
                  className={`
                    flex flex-col items-center p-4 rounded-lg border-2 transition-all
                    ${localSettings.typeDisplay === 'both'
                      ? 'border-blue-500 bg-selected'
                      : 'border-primary hover:border-secondary'
                    }
                  `}
                >
                  <span className="text-xs font-mono mb-1 text-primary">DATE/INT32</span>
                  <span className="text-sm font-medium text-primary">{t('settings.typeDisplayOptions.both')}</span>
                </button>
              </div>
              <p className="mt-2 text-xs text-tertiary">
                {t('settings.typeDisplayDesc')}
              </p>
            </div>

            {/* Recent Files Settings */}
            <div>
              <label className="block text-sm font-medium text-secondary mb-2">
                {t('common.recentFiles')}
              </label>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-primary">{t('settings.showRecentFiles')}</span>
                  <button
                    onClick={() => setLocalSettings({ ...localSettings, showRecentFiles: !localSettings.showRecentFiles })}
                    className={`
                      relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                      ${localSettings.showRecentFiles ? 'bg-blue-600' : 'bg-gray-300'}
                    `}
                  >
                    <span
                      className={`
                        inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                        ${localSettings.showRecentFiles ? 'translate-x-6' : 'translate-x-1'}
                      `}
                    />
                  </button>
                </div>

                <p className="text-xs text-tertiary">
                  {t('settings.recentFilesDesc')}
                </p>

                <button
                  onClick={() => {
                    if (confirm(t('settings.confirmClearRecent'))) {
                      clearRecentFiles();
                    }
                  }}
                  className="w-full px-3 py-2 text-sm text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                  disabled={!localSettings.showRecentFiles}
                >
                  {t('settings.clearRecentFiles')}
                </button>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end space-x-3 px-6 py-4 border-t border-primary">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-secondary hover:bg-tertiary rounded-md transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              {t('common.saveChanges')}
            </button>
          </div>
        </div>
      </div >
    </>
  );
}