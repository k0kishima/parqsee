import { ReactNode, useCallback, useEffect, useState, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
    DEFAULT_SIDEBAR_WIDTH,
    clampSidebarWidth,
    loadSidebarWidth,
    saveSidebarWidth,
} from '../../../lib/sidebar-width';

interface SidebarProps {
    isOpen: boolean;
    children: ReactNode;
}

/**
 * The explorer's column. Its right edge is a drag handle: the width is
 * remembered across launches, and a double-click on the handle restores
 * the default. The open / close transition is suspended while dragging so
 * the edge follows the pointer.
 */
export const Sidebar = ({ isOpen, children }: SidebarProps) => {
    const { t } = useTranslation();
    const [width, setWidth] = useState(loadSidebarWidth);
    const [dragging, setDragging] = useState(false);

    useEffect(() => {
        if (!dragging) saveSidebarWidth(width);
    }, [width, dragging]);

    const startDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // The second press of a double-click: reset instead of dragging. Read
        // here rather than from onDoubleClick, which never fires because the
        // overlay below takes the first press's release.
        if (e.detail === 2) {
            setWidth(DEFAULT_SIDEBAR_WIDTH);
            return;
        }
        const startX = e.clientX;
        const startWidth = width;
        setDragging(true);
        const move = (ev: PointerEvent) => setWidth(clampSidebarWidth(startWidth + ev.clientX - startX));
        const stop = () => {
            setDragging(false);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
    }, [width]);

    return (
        <div
            className={`relative overflow-hidden flex-shrink-0 ${dragging ? '' : 'transition-[width] duration-300'}`}
            style={{ width: isOpen ? width : 0 }}
        >
            {children}
            {isOpen && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    title={t('common.resizeSidebar')}
                    onPointerDown={startDrag}
                    className={`absolute top-0 right-0 h-full w-1.5 cursor-col-resize z-20 transition-colors hover:bg-blue-400/60 ${dragging ? 'bg-blue-500/70' : ''}`}
                />
            )}
            {/* While dragging, keep the pointer's cursor and stop text selection everywhere */}
            {dragging && <div className="fixed inset-0 z-50 cursor-col-resize select-none" />}
        </div>
    );
};
