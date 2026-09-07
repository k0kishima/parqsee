import React, { RefObject, useCallback, useState } from 'react';
import { Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppCommand, type AppCommand } from '../../../lib/app-commands';
import { shortcutKeys } from '../../../lib/shortcuts';

interface QueryEditorProps {
    onExecute: (query: string) => void;
    isLoading: boolean;
    /** See `QueryView`; absent when there is only one editor (tests). */
    isActiveRef?: RefObject<boolean>;
}

export const QueryEditor: React.FC<QueryEditorProps> = ({ onExecute, isLoading, isActiveRef }) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState('SELECT * FROM t LIMIT 100;');

    // ⌘↩, from the native menu or the workspace's keydown fallback (see
    // lib/app-commands.ts). Not a keydown on the textarea: on macOS the
    // menu's key equivalent takes the key before the webview sees it.
    useAppCommand(useCallback((command: AppCommand) => {
        if (command !== 'run-query' || isLoading) return;
        if (isActiveRef && !isActiveRef.current) return;
        onExecute(query);
    }, [isActiveRef, isLoading, onExecute, query]));

    const containerBg = 'bg-white border-gray-200 dark:bg-gray-900 dark:border-gray-700';
    const toolbarBg = 'bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-800';
    const textareaColor = 'text-gray-900 dark:text-gray-100';

    return (
        <div className={`flex flex-col h-full border-b ${containerBg}`}>
            <div className={`p-2 border-b flex justify-between items-center ${toolbarBg}`}>
                <span className="text-xs text-gray-500 font-mono">{t('viewer.query.tableName')}</span>
                <button
                    onClick={() => onExecute(query)}
                    disabled={isLoading}
                    className={`
                        btn-primary px-4 py-1.5 text-sm h-8 gap-2
                        ${isLoading ? 'cursor-not-allowed opacity-70' : ''}
                    `}
                >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    {isLoading ? t('viewer.query.running') : t('viewer.query.run')}
                    {/* The key beside the action, as on the Welcome screen's buttons. */}
                    <span className="text-xs opacity-60">{shortcutKeys('run-query')}</span>
                </button>
            </div>
            <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className={`flex-1 w-full p-4 font-mono text-sm resize-none focus:outline-none bg-transparent ${textareaColor}`}
                placeholder={t('viewer.query.placeholder')}
                spellCheck={false}
            />
        </div>
    );
};
