import React from 'react';
import { useTranslation } from 'react-i18next';
import { QueryResult } from '../types';

interface QueryResultsProps {
    result?: QueryResult;
    error?: string;
    isLoading: boolean;
}

export const QueryResults: React.FC<QueryResultsProps> = ({ result, error, isLoading }) => {
    const { t } = useTranslation();

    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center text-gray-400">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm">{t('viewer.query.executing')}</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className={`flex-1 p-4 overflow-auto bg-red-50 dark:bg-red-900/10`}>
                <div className={`font-mono text-sm whitespace-pre-wrap text-red-600 dark:text-red-400`}>
                    {error}
                </div>
            </div>
        );
    }

    if (!result) {
        return (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                {t('viewer.query.noResults')}
            </div>
        );
    }

    const containerBg = 'bg-white dark:bg-gray-900';
    const headerBg = 'bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-800';
    const headerText = 'text-gray-600 dark:text-gray-300';
    const headerBorder = 'border-gray-200 dark:border-gray-700';
    const rowHover = 'hover:bg-gray-50 dark:hover:bg-gray-800/50';
    const cellText = 'text-gray-900 dark:text-gray-100';
    const cellBorder = 'border-gray-100 dark:border-gray-800';

    return (
        <div className={`flex-1 flex flex-col overflow-hidden ${containerBg}`}>
            <div className={`p-2 border-b text-xs text-gray-500 flex justify-between ${headerBg}`}>
                <span>{t('viewer.query.rows', { count: result.rows.length })}</span>
                <span>{t('viewer.query.duration', { ms: result.execution_time_ms })}</span>
            </div>
            <div className="flex-1 overflow-auto">
                <table className="w-full text-left text-sm border-collapse">
                    <thead className={`sticky top-0 z-10 shadow-sm ${headerBg}`}>
                        <tr>
                            {result.columns.map((col) => (
                                <th key={col.name} className={`px-4 py-2 font-medium border-b whitespace-nowrap ${headerText} ${headerBorder}`}>
                                    <div className="flex flex-col">
                                        <span>{col.name}</span>
                                        <span className="text-[10px] text-gray-400 font-normal">{col.data_type}</span>
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className={`divide-y divide-gray-100 dark:divide-gray-800`}>
                        {result.rows.map((row, i) => (
                            <tr key={i} className={rowHover}>
                                {result.columns.map((col) => (
                                    <td key={`${i}-${col.name}`} className={`px-4 py-1.5 border-r last:border-r-0 whitespace-nowrap max-w-xs overflow-hidden text-ellipsis ${cellText} ${cellBorder}`}>
                                        {formatCell(row[col.name])}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const formatCell = (value: any): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};
