import React, { useState } from 'react';
import { useSettings } from '../../../contexts/SettingsContext';
import { executeSql } from '../api/execute-sql';
import { QueryEditor } from '../components/query-editor';
import { QueryResults } from '../components/query-results';
import { QueryResult } from '../types';

interface QueryViewProps {
    filePath: string;
}

export const QueryView: React.FC<QueryViewProps> = ({ filePath }) => {
    const { effectiveTheme } = useSettings();
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
            setError(typeof err === 'string' ? err : 'An unknown error occurred');
            setResult(undefined);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className={`flex flex-col h-full ${effectiveTheme === 'dark' ? 'bg-gray-900' : 'bg-slate-50'}`}>
            <div className="h-1/3 min-h-[150px] border-b border-gray-200 dark:border-gray-700 shadow-sm relative z-10">
                <QueryEditor onExecute={handleExecute} isLoading={isLoading} />
            </div>
            <div className="flex-1 overflow-hidden relative z-0">
                <QueryResults result={result} error={error} isLoading={isLoading} />
            </div>
        </div>
    );
};
