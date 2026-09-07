import React, { RefObject, useState } from 'react';
import { executeSql } from '../api/execute-sql';
import { QueryEditor } from '../components/query-editor';
import { QueryResults } from '../components/query-results';
import { QueryResult } from '../types';
import { toErrorMessage } from '../../../lib/tauri';

interface QueryViewProps {
    filePath: string;
    /**
     * True while this SQL view is the one on screen: the active tab, in
     * Query mode. Every tab's view stays mounted and hears ⌘↩; only this
     * one runs its query.
     */
    isActiveRef?: RefObject<boolean>;
}

export const QueryView: React.FC<QueryViewProps> = ({ filePath, isActiveRef }) => {
    const [result, setResult] = useState<QueryResult | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [isLoading, setIsLoading] = useState(false);

    const handleExecute = async (query: string) => {
        setIsLoading(true);
        setError(undefined);
        try {
            const data = await executeSql(filePath, query);
            setResult(data);
        } catch (err) {
            console.error(err);
            setError(toErrorMessage(err));
            setResult(undefined);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-50 dark:bg-gray-900">
            <div className="h-1/3 min-h-[150px] border-b border-gray-200 dark:border-gray-700 shadow-sm relative z-10">
                <QueryEditor onExecute={handleExecute} isLoading={isLoading} isActiveRef={isActiveRef} />
            </div>
            <div className="flex-1 overflow-hidden relative z-0 flex flex-col">
                <QueryResults result={result} error={error} isLoading={isLoading} />
            </div>
        </div>
    );
};
