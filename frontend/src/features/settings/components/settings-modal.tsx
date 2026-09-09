import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Sun, Moon, Monitor, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { useSettings } from '../../../contexts/SettingsContext';
import { useGlobalKeydown } from '../../../hooks/useGlobalKeydown';
import { PurchaseSettings } from '../../license';
import type { Theme } from '../../../lib/settings-storage';
import { shortcutKeys } from '../../../lib/shortcuts';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Open the keyboard shortcut sheet (over this dialog). */
  onShowShortcuts: () => void;
}

/** One row of the dialog: the label on the left, the control on the right. */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-6 py-3">
      <span className="text-sm text-primary">{label}</span>
      {children}
    </div>
  );
}

const THEMES: { value: Theme; Icon: typeof Sun }[] = [
  { value: 'light', Icon: Sun },
  { value: 'dark', Icon: Moon },
  { value: 'system', Icon: Monitor },
];

/**
 * Settings, as a small centred dialog: language, theme, the startup option
 * and — in a build with a store — the purchase. Every control applies at
 * once, as the viewer's own controls (rows per page, density) do, so there
 * is nothing to save; Escape, ✕ and the backdrop close it.
 *
 * What the viewer can change in place is not repeated here: rows per page
 * lives in the pagination bar, row density and column types in the
 * viewer's view options.
 */
export function SettingsModal({ isOpen, onClose, onShowShortcuts }: SettingsModalProps) {
  const { settings, updateSettings } = useSettings();
  const { t } = useTranslation();
  // `tauri.conf.json`'s version, which is the bundle's
  // CFBundleShortVersionString — not the build number appstore.sh sets.
  // A plain browser (vitest, the e2e harness without the shim) has no
  // command to answer it, so the row is left out rather than shown empty.
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    getVersion()
      .then(v => { if (live) setVersion(v); })
      .catch(() => { if (live) setVersion(null); });
    return () => { live = false; };
  }, [isOpen]);

  useGlobalKeydown(useCallback((e: KeyboardEvent) => {
    if (isOpen && e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [isOpen, onClose]));

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/20 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-2xl bg-primary border border-primary"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-primary">
          <h2 id="settings-title" className="text-lg font-semibold text-primary">
            {t('settings.title')}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-tertiary hover:text-primary hover:bg-tertiary transition-colors"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="py-2 divide-y divide-slate-200 dark:divide-gray-700">
          <SettingRow label={t('settings.language')}>
            <select
              value={settings.language}
              onChange={(e) => updateSettings({ language: e.target.value as 'en' | 'ja' })}
              aria-label={t('settings.language')}
              className="px-3 py-1.5 text-sm border border-primary rounded-md bg-primary text-primary focus:outline-none focus:ring-2 focus:ring-blue-500 hover:border-secondary transition-colors cursor-pointer"
            >
              <option value="en">English (US)</option>
              <option value="ja">日本語</option>
            </select>
          </SettingRow>

          <SettingRow label={t('settings.theme')}>
            <div role="radiogroup" aria-label={t('settings.theme')} className="inline-flex rounded-md border border-primary p-0.5 bg-secondary">
              {THEMES.map(({ value, Icon }) => {
                const selected = settings.theme === value;
                return (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={selected}
                    onClick={() => updateSettings({ theme: value })}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-sm rounded transition-colors ${selected
                      ? 'bg-primary text-primary shadow-sm'
                      : 'text-tertiary hover:text-primary'}`}
                  >
                    <Icon size={14} />
                    {t(`settings.themeOptions.${value}`)}
                  </button>
                );
              })}
            </div>
          </SettingRow>

          <SettingRow label={t('settings.restoreTabs')}>
            <button
              onClick={() => updateSettings({ restoreTabs: !settings.restoreTabs })}
              role="switch"
              aria-checked={settings.restoreTabs}
              aria-label={t('settings.restoreTabs')}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${settings.restoreTabs ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.restoreTabs ? 'translate-x-6' : 'translate-x-1'}`}
              />
            </button>
          </SettingRow>

          <SettingRow label={t('settings.shortcuts')}>
            <button
              onClick={onShowShortcuts}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-primary rounded-md bg-primary text-primary hover:border-secondary transition-colors"
            >
              {t('settings.showShortcuts')}
              <span className="text-xs text-tertiary">{shortcutKeys('shortcuts')}</span>
            </button>
          </SettingRow>

          {/* Nothing in a build without a store. */}
          <PurchaseSettings />

          {version && (
            <SettingRow label={t('settings.version')}>
              <span className="text-sm text-tertiary tabular-nums">{version}</span>
            </SettingRow>
          )}
        </div>
      </div>
    </div>
  );
}
