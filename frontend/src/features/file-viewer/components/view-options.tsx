import { useCallback, useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../../contexts/SettingsContext';
import type { RowDensity, TypeDisplay } from '../../../lib/settings-storage';

const DENSITIES: RowDensity[] = ['comfortable', 'compact'];
const TYPE_DISPLAYS: TypeDisplay[] = ['logical', 'physical', 'both'];

interface ChoiceProps<T extends string> {
  label: string;
  options: T[];
  value: T;
  optionLabel: (value: T) => string;
  onChange: (value: T) => void;
}

/** A labelled segmented control: one button per option, the current one raised. */
function Choice<T extends string>({ label, options, value, optionLabel, onChange }: ChoiceProps<T>) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-sm text-primary">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-primary p-0.5 bg-secondary">
        {options.map(option => {
          const selected = option === value;
          return (
            <button
              key={option}
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option)}
              className={`px-2.5 py-1 text-sm rounded transition-colors ${selected
                ? 'bg-primary text-primary shadow-sm'
                : 'text-tertiary hover:text-primary'}`}
            >
              {optionLabel(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface ViewOptionsProps {
  /** The toolbar button's classes, shared with its neighbours. */
  buttonClassName: string;
}

/**
 * The grid's own display settings — row density and how column types are
 * labelled — behind one toolbar button, so they are changed where their
 * effect is seen instead of in the settings dialog. Both are settings
 * (they persist and the query grid shares the density), only the control
 * lives here. Rows per page stays in the pagination bar.
 */
export function ViewOptions({ buttonClassName }: ViewOptionsProps) {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettings();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else, and on Escape.
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    // Capture, so the viewer's own Escape handling (search) does not see it.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={buttonClassName}
        title={t('viewer.viewOptions.title')}
        aria-label={t('viewer.viewOptions.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <SlidersHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('viewer.viewOptions.title')}
          className="absolute right-0 top-full mt-1 z-30 w-max rounded-lg border border-primary bg-primary shadow-lg p-4 space-y-3"
        >
          <Choice
            label={t('viewer.viewOptions.rowDensity')}
            options={DENSITIES}
            value={settings.rowDensity}
            optionLabel={d => t(`viewer.viewOptions.rowDensityOptions.${d}`)}
            onChange={rowDensity => updateSettings({ rowDensity })}
          />
          <Choice
            label={t('viewer.viewOptions.typeDisplay')}
            options={TYPE_DISPLAYS}
            value={settings.typeDisplay}
            optionLabel={d => t(`viewer.viewOptions.typeDisplayOptions.${d}`)}
            onChange={typeDisplay => updateSettings({ typeDisplay })}
          />
        </div>
      )}
    </div>
  );
}
