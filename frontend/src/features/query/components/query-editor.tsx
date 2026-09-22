import React, { RefObject, useCallback, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppCommand, type AppCommand } from '../../../lib/app-commands';
import { shortcutKeys } from '../../../lib/shortcuts';

interface QueryEditorProps {
    onExecute: (query: string) => void;
    /** Stop the run in flight; only offered while there is one. */
    onStop: () => void;
    isLoading: boolean;
    /** See `QueryView`; absent when there is only one editor (tests). */
    isActiveRef?: RefObject<boolean>;
}

export const QueryEditor: React.FC<QueryEditorProps> = ({ onExecute, onStop, isLoading, isActiveRef }) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState('SELECT * FROM t LIMIT 100;');

    // ⌘↩ and ⌘., from the native menu or the workspace's keydown fallback
    // (see lib/app-commands.ts). Not a keydown on the textarea: on macOS
    // the menu's key equivalent takes the key before the webview sees it.
    // ⌘↩ during a run is a run — the one in flight is stopped for it. It
    // used to be dropped instead, and nothing said so: the button read
    // Running… and the key did nothing at all.
    useAppCommand(useCallback((command: AppCommand) => {
        if (isActiveRef && !isActiveRef.current) return;
        if (command === 'run-query') onExecute(query);
        else if (command === 'stop-query' && isLoading) onStop();
    }, [isActiveRef, isLoading, onExecute, onStop, query]));

    // No bottom border here: the seam with the results is the pane's, in
    // `QueryView`, and a second one on top of it drew a 2px line where
    // every other divider in the app is 1px.
    const containerBg = 'bg-white dark:bg-gray-900';
    const toolbarBg = 'bg-gray-50 border-primary dark:bg-gray-800';
    const textareaColor = 'text-gray-900 dark:text-gray-100';

    return (
        <div className={`flex flex-col h-full ${containerBg}`}>
            <div className={`p-2 border-b flex justify-between items-center ${toolbarBg}`}>
                <span className="text-xs text-gray-500 font-mono">{t('viewer.query.tableName')}</span>
                <div className="flex items-center gap-2">
                    {isLoading && (
                        <button onClick={onStop} className="btn-secondary px-3 py-1.5 text-sm h-8 gap-2">
                            <Square className="w-3 h-3 fill-current" />
                            {t('viewer.query.stop')}
                            <span className="text-xs opacity-60">{shortcutKeys('stop-query')}</span>
                        </button>
                    )}
                    {/* Enabled during a run as well: a click then is a re-run
                        over the one in flight, as ⌘↩ is. */}
                    <button onClick={() => onExecute(query)} className="btn-primary px-4 py-1.5 text-sm h-8 gap-2">
                        <Play className="w-3.5 h-3.5 fill-current" />
                        {t('viewer.query.run')}
                        {/* The key beside the action, as on the Welcome screen's buttons. */}
                        <span className="text-xs opacity-60">{shortcutKeys('run-query')}</span>
                    </button>
                </div>
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
