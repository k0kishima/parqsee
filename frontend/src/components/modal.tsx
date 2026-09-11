import { useCallback, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGlobalKeydown } from '../hooks/useGlobalKeydown';

interface ModalProps {
  /** Called on Escape, on a click on the backdrop and by `ModalCloseButton`. */
  onClose: () => void;
  /** The id of the element that names the dialog (its `ModalHeader` title). */
  labelledBy: string;
  /** Classes on the backdrop: the stacking level and the tint. */
  overlayClassName?: string;
  /** Classes on the panel: its width, and anything its layout needs. */
  panelClassName?: string;
  testId?: string;
  children: ReactNode;
}

/**
 * The centred dialog every modal is drawn as: a blurred backdrop over the
 * whole window, a rounded panel, and the three ways out — Escape, a click
 * on the backdrop, and `ModalCloseButton` in the header. A click inside
 * the panel stays inside. Mount it only while the dialog is open: the
 * Escape listener lives as long as the component does.
 *
 * Popovers and context menus are not modals and do not use this: they sit
 * under their button, take Escape from `document`, and have no backdrop.
 */
export function Modal({
  onClose,
  labelledBy,
  overlayClassName = 'z-50 bg-black/20',
  panelClassName = '',
  testId,
  children,
}: ModalProps) {
  useGlobalKeydown(useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose]));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      data-testid={testId}
      className={`fixed inset-0 flex items-center justify-center p-6 backdrop-blur-sm ${overlayClassName}`}
      onClick={onClose}
    >
      <div
        className={`w-full rounded-2xl shadow-2xl bg-primary border border-primary ${panelClassName}`}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** The ✕ in a modal's header. */
export function ModalCloseButton({ onClose, className = '' }: { onClose: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClose}
      className={`p-1.5 rounded-md text-tertiary hover:text-primary hover:bg-tertiary transition-colors ${className}`}
      title={t('common.close')}
      aria-label={t('common.close')}
    >
      <X size={16} />
    </button>
  );
}

/** The plain header: the title on the left, ✕ on the right. */
export function ModalHeader({ id, title, onClose }: { id: string; title: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-primary">
      <h2 id={id} className="text-lg font-semibold text-primary">
        {title}
      </h2>
      <ModalCloseButton onClose={onClose} />
    </div>
  );
}
