import { useCallback } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGlobalKeydown } from '../../../hooks/useGlobalKeydown';
import { SHORTCUTS, SHORTCUT_SECTIONS, shortcutKeys } from '../../../lib/shortcuts';

interface ShortcutSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

/** One key or key combination, drawn as a keycap. */
function Keycap({ keys }: { keys: string }) {
  return (
    <kbd className="inline-block min-w-[1.75rem] px-1.5 py-0.5 rounded border border-primary bg-secondary text-center text-xs font-sans text-secondary">
      {keys}
    </kbd>
  );
}

/**
 * Every keyboard shortcut on one sheet (⌘/, Help › Keyboard Shortcuts,
 * Settings, the Welcome screen's "Easy to Use" card), by section, from
 * the one table in `lib/shortcuts.ts`. Escape, ✕ and the backdrop close
 * it. Settings closes itself when its row opens this, so one Escape
 * closes one thing.
 */
export function ShortcutSheet({ isOpen, onClose }: ShortcutSheetProps) {
  const { t } = useTranslation();

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
      aria-labelledby="shortcuts-title"
      className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/20 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-full flex flex-col rounded-2xl shadow-2xl bg-primary border border-primary"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-primary">
          <h2 id="shortcuts-title" className="text-lg font-semibold text-primary">
            {t('shortcuts.title')}
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

        <div className="overflow-y-auto px-6 py-4 grid gap-x-10 gap-y-5 grid-cols-1 sm:grid-cols-2">
          {SHORTCUT_SECTIONS.map(section => (
            <section key={section} aria-labelledby={`shortcuts-${section}`}>
              <h3 id={`shortcuts-${section}`} className="mb-2 text-xs font-semibold uppercase tracking-wider text-tertiary">
                {t(`shortcuts.sections.${section}`)}
              </h3>
              <dl className="space-y-1.5">
                {SHORTCUTS.filter(shortcut => shortcut.section === section).map(shortcut => (
                  <div key={shortcut.id} className="flex items-center justify-between gap-4">
                    <dt className="text-sm text-primary">{t(`shortcuts.${shortcut.id}`)}</dt>
                    <dd className="flex items-center gap-1 whitespace-nowrap" aria-label={shortcutKeys(shortcut.id)}>
                      {shortcut.keys.map((keys, i) => (
                        <span key={keys} className="flex items-center gap-1">
                          {i > 0 && <span className="text-xs text-tertiary">/</span>}
                          <Keycap keys={keys} />
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
