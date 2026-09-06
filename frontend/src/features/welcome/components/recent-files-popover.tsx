import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, X } from 'lucide-react';
import { useRecentFiles } from '../../../contexts/RecentFilesContext';
import { useGlobalKeydown } from '../../../hooks/useGlobalKeydown';
import { formatFileSize } from '../../../lib/format';
import { confirmDestructive } from '../../../lib/dialog';

interface RecentFilesPopoverProps {
    onFileSelect: (path: string) => void;
    onClose: () => void;
}

/**
 * Recent Files as a panel dropped from the top row's clock button — the
 * same list the Welcome screen shows, reachable while tabs are open, which
 * the Welcome screen by definition is not. Compact rows; the Welcome screen
 * keeps its cards.
 *
 * Positioned by the caller: `absolute` under a `relative` wrapper around
 * the button, aligned to its right edge. Picking a file opens it and closes
 * the panel; removing an entry keeps it open, as does Clear all, which
 * leaves the empty state showing.
 */
export const RecentFilesPopover: React.FC<RecentFilesPopoverProps> = ({ onFileSelect, onClose }) => {
    const { recentFiles, removeRecentFile, clearRecentFiles } = useRecentFiles();
    const { t } = useTranslation();
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleMouseDown = (e: MouseEvent) => {
            const target = e.target as Node;
            // The button that opened the panel toggles it itself.
            const trigger = panelRef.current?.parentElement;
            if (trigger && !trigger.contains(target)) onClose();
        };
        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [onClose]);

    useGlobalKeydown(
        useCallback((e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        }, [onClose]),
        'document'
    );

    return (
        <div
            ref={panelRef}
            role="dialog"
            aria-label={t('common.recentFiles')}
            className="absolute right-0 top-full mt-1 z-50 w-[26rem] max-w-[calc(100vw-1rem)] rounded-md shadow-lg border border-primary bg-primary py-1"
        >
            <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-xs font-medium text-secondary">{t('common.recentFiles')}</span>
                {recentFiles.length > 0 && (
                    <button
                        onClick={async () => {
                            if (await confirmDestructive(t('welcome.recentFiles.confirmClear'))) clearRecentFiles();
                        }}
                        className="text-xs text-tertiary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    >
                        {t('welcome.recentFiles.clear')}
                    </button>
                )}
            </div>
            {recentFiles.length === 0 ? (
                <p className="px-3 py-2 text-xs text-tertiary">{t('welcome.recentFiles.empty')}</p>
            ) : (
                <ul className="max-h-[60vh] overflow-y-auto scrollbar-thin">
                    {recentFiles.map(file => (
                        <li
                            key={file.path}
                            className={`group flex items-center hover:bg-tertiary ${file.available ? '' : 'opacity-60'}`}
                        >
                            <button
                                onClick={() => {
                                    onFileSelect(file.path);
                                    onClose();
                                }}
                                className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left"
                                title={file.path}
                            >
                                <FileText className="w-4 h-4 flex-shrink-0 text-tertiary" />
                                <span className="flex-1 min-w-0">
                                    <span className="block text-xs text-primary truncate">{file.name}</span>
                                    <span className="block text-[11px] text-tertiary truncate">
                                        {file.available ? file.path : t('welcome.recentFiles.unavailable')}
                                    </span>
                                </span>
                                <span className="flex-shrink-0 text-right">
                                    <span className="block text-[11px] text-secondary">{formatFileSize(file.size)}</span>
                                    <span className="block text-[11px] text-tertiary">{new Date(file.last_accessed).toLocaleDateString()}</span>
                                </span>
                            </button>
                            <button
                                onClick={() => removeRecentFile(file.path)}
                                className="p-1.5 mr-1 rounded text-tertiary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                                title={t('welcome.recentFiles.remove')}
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
