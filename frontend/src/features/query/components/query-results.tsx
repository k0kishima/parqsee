import React, { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { QueryResult } from '../types';
import { useColumnVirtualizer } from '../../../hooks/useColumnVirtualizer';
import { measureColumnWidths, MAX_COLUMN_WIDTH } from '../../../lib/column-widths';

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
            <div className="flex-1 p-4 overflow-auto bg-red-50 dark:bg-red-900/10">
                <div className="font-mono text-sm whitespace-pre-wrap text-red-600 dark:text-red-400">
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

    return (
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-900">
            <div className="p-2 border-b text-xs text-gray-500 flex justify-between bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-800">
                <span>{t('viewer.query.rows', { count: result.rows.length })}</span>
                <span>{t('viewer.query.duration', { ms: result.execution_time_ms })}</span>
            </div>
            <ResultGrid result={result} />
        </div>
    );
};

/**
 * The result grid. Like the browse table, only the columns that overlap the
 * scroll viewport are rendered: `SELECT *` on a wide file would otherwise
 * put every cell of the result in the DOM at once.
 */
const ResultGrid: React.FC<{ result: QueryResult }> = ({ result }) => {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const { columns, rows } = result;

    const widths = useMemo(
        () => measureColumnWidths(
            columns.map(col => ({ name: col.name, typeLabel: col.data_type })),
            rows,
            { format: formatCell, valueFont: 'sans' }
        ),
        [columns, rows]
    );

    const virt = useColumnVirtualizer(widths, scrollerRef);
    const { start, end, padLeft, totalWidth, viewportWidth } = virt;
    const padRight = virt.padRight + Math.max(0, viewportWidth - totalWidth);
    const tableWidth = Math.max(totalWidth, viewportWidth);
    const visibleColumns = useMemo(() => columns.slice(start, end), [columns, start, end]);

    const headerBg = 'bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-800';

    return (
        <div ref={scrollerRef} onScroll={virt.onScroll} className="flex-1 overflow-auto">
            <table className="text-left text-sm border-collapse" style={{ tableLayout: 'fixed', width: tableWidth }}>
                <colgroup>
                    {padLeft > 0 && <col style={{ width: padLeft }} />}
                    {visibleColumns.map((_, i) => (
                        <col key={start + i} style={{ width: widths[start + i] }} />
                    ))}
                    {padRight > 0 && <col style={{ width: padRight }} />}
                </colgroup>
                <thead className={`sticky top-0 z-10 shadow-sm ${headerBg}`}>
                    <tr>
                        {padLeft > 0 && <th aria-hidden="true" />}
                        {visibleColumns.map((col, i) => (
                            <th
                                key={start + i}
                                title={col.name}
                                className="px-4 py-2 font-medium border-b whitespace-nowrap overflow-hidden text-ellipsis text-gray-600 border-gray-200 dark:text-gray-300 dark:border-gray-700"
                            >
                                <div className="flex flex-col">
                                    <span>{col.name}</span>
                                    <span className="text-[10px] text-gray-400 font-normal">{col.data_type}</span>
                                </div>
                            </th>
                        ))}
                        {padRight > 0 && <th aria-hidden="true" />}
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {rows.map((row, r) => (
                        <tr key={r} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                            {padLeft > 0 && <td aria-hidden="true" />}
                            {visibleColumns.map((col, i) => {
                                const text = formatCell(row[col.name]);
                                const mayTruncate = widths[start + i] >= MAX_COLUMN_WIDTH;
                                return (
                                    <td
                                        key={start + i}
                                        title={mayTruncate ? text : undefined}
                                        className="px-4 py-1.5 border-r whitespace-nowrap overflow-hidden text-ellipsis text-gray-900 border-gray-100 dark:text-gray-100 dark:border-gray-800"
                                    >
                                        {text}
                                    </td>
                                );
                            })}
                            {padRight > 0 && <td aria-hidden="true" />}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};
