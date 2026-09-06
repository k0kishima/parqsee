import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, XSquare, ChevronsRight } from 'lucide-react';
import { useGlobalKeydown } from '../../../hooks/useGlobalKeydown';

export interface TabContextMenuProps {
  /** Viewport coordinates of the right-click. */
  x: number;
  y: number;
  /** False when the tab is the only one open. */
  canCloseOthers: boolean;
  /** False when the tab is the last one in the bar. */
  canCloseToRight: boolean;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onDismiss: () => void;
}

/** Kept clear of the window edges when the menu has to be nudged inwards. */
const EDGE_MARGIN = 8;

/**
 * The tab bar's right-click menu, Chrome's set minus what this app has no
 * notion of (pinning, muting, moving to a window).
 *
 * Positioned `fixed` at the click: the tab bar scrolls horizontally and is
 * only one row tall, so a menu placed inside it would be clipped by that
 * overflow. It is nudged back inside the window when it would hang off the
 * right or bottom edge.
 */
export const TabContextMenu: React.FC<TabContextMenuProps> = ({
  x,
  y,
  canCloseOthers,
  canCloseToRight,
  onCloseTab,
  onCloseOthers,
  onCloseToRight,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      x: Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - rect.width - EDGE_MARGIN)),
      y: Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - rect.height - EDGE_MARGIN)),
    });
  }, [x, y]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onDismiss]);

  useGlobalKeydown(
    useCallback((e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    }, [onDismiss]),
    'document'
  );

  const item = (
    label: string,
    Icon: typeof X,
    enabled: boolean,
    action: () => void
  ) => (
    <button
      role="menuitem"
      disabled={!enabled}
      onClick={() => {
        if (!enabled) return;
        action();
        onDismiss();
      }}
      className={`w-full flex items-center px-3 py-1.5 text-xs text-primary whitespace-nowrap
        ${enabled ? 'hover:bg-tertiary' : 'opacity-50 cursor-not-allowed'}`}
    >
      <Icon className="w-3.5 h-3.5 mr-2 flex-shrink-0" />
      {label}
    </button>
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[180px] rounded-md shadow-lg border border-primary bg-primary py-1"
      style={{ left: position.x, top: position.y }}
    >
      {item(t('tabs.contextMenu.close'), X, true, onCloseTab)}
      {item(t('tabs.contextMenu.closeOthers'), XSquare, canCloseOthers, onCloseOthers)}
      {item(t('tabs.contextMenu.closeToRight'), ChevronsRight, canCloseToRight, onCloseToRight)}
    </div>
  );
};
