import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Search, X } from 'lucide-react';
import { useRecentFiles } from '../../../contexts/RecentFilesContext';
import { useGlobalKeydown } from '../../../hooks/useGlobalKeydown';
import { formatFileSize } from '../../../lib/format';
import { matchesRecentFile, recentFileLabels } from '../lib/recent-file-labels';

interface RecentFilesPopoverProps {
    onFileSelect: (path: string) => void;
    onClose: () => void;
}

/**
 * Recent Files as a panel dropped from the top row's clock button — the
 * same list the Welcome screen shows, reachable while tabs are open, which
 * the Welcome screen by definition is not. Compact rows, all entries (the
 * Welcome screen folds past five), a search box over name and path since
 * twenty rows is past scanning; Enter opens the first match. Two entries
 * with the same file name carry their parent folder, because the path line
 * is cut at the end where they differ.
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
    const [query, setQuery] = useState('');

    const labels = useMemo(() => recentFileLabels(recentFiles), [recentFiles]);
    const shown = useMemo(() => recentFiles.filter(file => matchesRecentFile(file, query)), [recentFiles, query]);

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

    const pick = (path: string) => {
        onFileSelect(path);
        onClose();
    };

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
                        onClick={clearRecentFiles}
                        className="text-xs text-tertiary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    >
                        {t('welcome.recentFiles.clear')}
                    </button>
                )}
            </div>
            {recentFiles.length > 0 && (
                <div className="px-3 pb-1.5">
                    <label className="flex items-center gap-2 px-2 py-1 rounded border border-primary bg-secondary">
                        <Search className="w-3.5 h-3.5 shrink-0 text-tertiary" />
                        <input
                            type="search"
                            autoFocus
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && shown.length > 0) pick(shown[0].path);
                            }}
                            placeholder={t('welcome.recentFiles.search')}
                            aria-label={t('welcome.recentFiles.search')}
                            className="flex-1 min-w-0 bg-transparent text-xs text-primary placeholder:text-tertiary outline-none"
                        />
                    </label>
                </div>
            )}
            {recentFiles.length === 0 ? (
                <p className="px-3 py-2 text-xs text-tertiary">{t('welcome.recentFiles.empty')}</p>
            ) : shown.length === 0 ? (
                <p className="px-3 py-2 text-xs text-tertiary">{t('welcome.recentFiles.noMatches')}</p>
            ) : (
                <ul className="max-h-[60vh] overflow-y-auto scrollbar-thin">
                    {shown.map(file => {
                        const label = labels.get(file.path);
                        return (
                            <li
                                key={file.path}
                                className={`group flex items-center hover:bg-tertiary ${file.available ? '' : 'opacity-60'}`}
                            >
                                <button
                                    onClick={() => pick(file.path)}
                                    className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left"
                                    title={file.path}
                                >
                                    <FileText className="w-4 h-4 shrink-0 text-tertiary" />
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-xs text-primary truncate">
                                            {file.name}
                                            {label?.folder && <span className="text-tertiary"> · {label.folder}</span>}
                                        </span>
                                        <span className="block text-[11px] text-tertiary truncate">
                                            {file.available ? file.path : t('welcome.recentFiles.unavailable')}
                                        </span>
                                    </span>
                                    <span className="shrink-0 text-right">
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
                        );
                    })}
                </ul>
            )}
        </div>
    );
};
