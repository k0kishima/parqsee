import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRecentFiles } from '../../../contexts/RecentFilesContext';
import { formatFileSize } from '../../../lib/format';
import { confirmDestructive } from '../../../lib/dialog';

interface RecentFilesListProps {
    onFileSelect: (path: string) => void;
}

/**
 * How many entries the Welcome screen shows before folding the rest behind
 * "Show all": the store keeps twenty (`MAX_RECENT`), which as full-width
 * cards would push the feature highlights off the screen.
 */
export const WELCOME_RECENT_LIMIT = 5;

export const RecentFilesList: React.FC<RecentFilesListProps> = ({ onFileSelect }) => {
    const { recentFiles, removeRecentFile, clearRecentFiles } = useRecentFiles();
    const { t } = useTranslation();
    const [showAll, setShowAll] = useState(false);
    const folded = recentFiles.length > WELCOME_RECENT_LIMIT && !showAll;
    const shown = folded ? recentFiles.slice(0, WELCOME_RECENT_LIMIT) : recentFiles;

    return (
        <div className="mt-12">
            <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold flex items-center text-slate-800 dark:text-gray-200">
                    <svg className="w-5 h-5 mr-2 text-slate-400 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {t('common.recentFiles')}
                </h3>
                {/* Each entry has its own ✕; this is the whole list at once.
                    It used to live in Settings, a screen away from the list. */}
                {recentFiles.length > 0 && (
                    <button
                        onClick={async () => {
                            if (await confirmDestructive(t('welcome.recentFiles.confirmClear'))) clearRecentFiles();
                        }}
                        className="text-sm text-slate-500 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-400 transition-colors"
                    >
                        {t('welcome.recentFiles.clear')}
                    </button>
                )}
            </div>
            <div className="space-y-2">
                {recentFiles.length === 0 ? (
                    <p className="text-sm text-slate-500 dark:text-gray-500">{t('welcome.recentFiles.empty')}</p>
                ) : (
                    shown.map((file) => (
                        <div
                            key={file.path}
                            className={`w-full flex items-center rounded-lg border transition-all group bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm dark:bg-gray-800 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:shadow-none ${file.available ? '' : 'opacity-60'}`}
                        >
                            <button
                                onClick={() => onFileSelect(file.path)}
                                className="flex-1 text-left p-4"
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center space-x-3">
                                        <div className="w-10 h-10 rounded-lg flex items-center justify-center transition-colors bg-slate-100 group-hover:bg-blue-50 dark:bg-gray-700 dark:group-hover:bg-gray-600">
                                            <svg className="w-5 h-5 text-slate-400 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                        </div>
                                        <div>
                                            <p className="font-medium transition-colors text-slate-700 group-hover:text-blue-600 dark:text-gray-200 dark:group-hover:text-blue-400">
                                                {file.name}
                                            </p>
                                            <p className="text-sm text-slate-500 dark:text-gray-500">
                                                {file.path}
                                            </p>
                                            {!file.available && (
                                                <p className="text-xs text-amber-600 dark:text-amber-400">
                                                    {t('welcome.recentFiles.unavailable')}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-sm font-medium text-slate-600 dark:text-gray-400">
                                            {formatFileSize(file.size)}
                                        </p>
                                        <p className="text-xs text-slate-500 dark:text-gray-500">
                                            {new Date(file.last_accessed).toLocaleString()}
                                        </p>
                                    </div>
                                </div>
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    removeRecentFile(file.path);
                                }}
                                className="p-4 transition-colors text-slate-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400"
                                title={t('welcome.recentFiles.remove')}
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    ))
                )}
            </div>
            {recentFiles.length > WELCOME_RECENT_LIMIT && (
                <button
                    onClick={() => setShowAll(open => !open)}
                    className="mt-3 text-sm text-slate-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 transition-colors"
                >
                    {folded ? t('welcome.recentFiles.showAll', { count: recentFiles.length }) : t('welcome.recentFiles.showLess')}
                </button>
            )}
        </div>
    );
};
