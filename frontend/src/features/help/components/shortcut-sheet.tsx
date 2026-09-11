import { useTranslation } from 'react-i18next';
import { Modal, ModalHeader } from '../../../components/modal';
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

  if (!isOpen) return null;

  return (
    <Modal
      onClose={onClose}
      labelledBy="shortcuts-title"
      overlayClassName="z-[60] bg-black/20"
      panelClassName="max-w-2xl max-h-full flex flex-col"
    >
      <ModalHeader id="shortcuts-title" title={t('shortcuts.title')} onClose={onClose} />

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
    </Modal>
  );
}
