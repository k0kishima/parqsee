import { useState, useEffect } from 'react';
import { useSettings } from '../contexts/SettingsContext';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSettings } = useSettings();
  const [localSettings, setLocalSettings] = useState(settings);

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
              Settings
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
            {/* Theme Setting */}
            <div>
              <label className="block text-sm font-medium text-secondary mb-2">
                Theme
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
                  <span className="text-sm font-medium text-primary">Light</span>
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
                  <span className="text-sm font-medium text-primary">Dark</span>
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
                  <span className="text-sm font-medium text-primary">System</span>
                </button>
              </div>
            </div>

            {/* Rows Per Page Setting */}
            <div>
              <label className="block text-sm font-medium text-secondary mb-2">
                Rows per page
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
                Number of rows to display per page in the data viewer
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end space-x-3 px-6 py-4 border-t border-primary">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-secondary hover:bg-tertiary rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </>
  );
}