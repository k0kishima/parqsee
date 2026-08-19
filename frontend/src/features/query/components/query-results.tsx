import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QueryResult } from '../types';
import { useColumnVirtualizer, useRowVirtualizer } from '../../../hooks/useVirtualRange';
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
            <div className="p-2 border-b text-xs text-gray-500 flex justify-between gap-4 bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-800">
                <span>
                    {t('viewer.query.rows', { count: result.rows.length })}
                    {result.truncated && (
                        <span className="ml-2 text-amber-700 dark:text-amber-400">
                            {t('viewer.query.truncated', { max: result.max_rows.toLocaleString() })}
                        </span>
                    )}
                </span>
                <span>{t('viewer.query.duration', { ms: result.execution_time_ms })}</span>
            </div>
            <ResultGrid result={result} />
        </div>
    );
};

/** Row pitch assumed until the first rows have been measured. */
const DEFAULT_ROW_HEIGHT = 33;

/**
 * The result grid. Like the browse table, only the columns that overlap the
 * scroll viewport are rendered, and because a query can return thousands of
 * rows, only the rows that overlap it as well.
 */
const ResultGrid: React.FC<{ result: QueryResult }> = ({ result }) => {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const tbodyRef = useRef<HTMLTableSectionElement>(null);
    const { columns, rows } = result;

    const widths = useMemo(
        () => measureColumnWidths(
            columns.map(col => ({ name: col.name, typeLabel: col.data_type })),
            rows,
            { format: formatCell, valueFont: 'sans' }
        ),
        [columns, rows]
    );

    // Rows are single-line, so they share one height; measure the pitch of the
    // rendered rows and size every row with it.
    const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
    const heights = useMemo(() => new Array<number>(rows.length).fill(rowHeight), [rows.length, rowHeight]);

    const cols = useColumnVirtualizer(widths, scrollerRef);
    const rowsVirt = useRowVirtualizer(heights, scrollerRef);

    useLayoutEffect(() => {
        const body = tbodyRef.current;
        if (!body) return;
        const dataRows = body.querySelectorAll<HTMLTableRowElement>('tr[data-row]');
        if (dataRows.length < 2) return;
        const first = dataRows[0].getBoundingClientRect();
        const last = dataRows[dataRows.length - 1].getBoundingClientRect();
        const pitch = (last.bottom - first.top) / dataRows.length;
        if (pitch > 0 && Math.abs(pitch - rowHeight) > 0.01) setRowHeight(pitch);
    }, [rowsVirt.start, rowsVirt.end, rowHeight]);

    const padLeft = cols.padStart;
    const padRight = cols.padEnd + Math.max(0, cols.viewportSize - cols.totalSize);
    const tableWidth = Math.max(cols.totalSize, cols.viewportSize);
    const visibleColumns = useMemo(() => columns.slice(cols.start, cols.end), [columns, cols.start, cols.end]);
    const cellCount = visibleColumns.length + (padLeft > 0 ? 1 : 0) + (padRight > 0 ? 1 : 0);

    const headerBg = 'bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-800';

    const onScroll = () => {
        cols.onScroll();
        rowsVirt.onScroll();
    };

    return (
        <div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-auto">
            <table className="text-left text-sm border-collapse" style={{ tableLayout: 'fixed', width: tableWidth }}>
                <colgroup>
                    {padLeft > 0 && <col style={{ width: padLeft }} />}
                    {visibleColumns.map((_, i) => (
                        <col key={cols.start + i} style={{ width: widths[cols.start + i] }} />
                    ))}
                    {padRight > 0 && <col style={{ width: padRight }} />}
                </colgroup>
                <thead className={`sticky top-0 z-10 shadow-sm ${headerBg}`}>
                    <tr>
                        {padLeft > 0 && <th aria-hidden="true" />}
                        {visibleColumns.map((col, i) => (
                            <th
                                key={cols.start + i}
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
                <tbody ref={tbodyRef} className="divide-y divide-gray-100 dark:divide-gray-800">
                    {rowsVirt.padStart > 0 && (
                        <tr aria-hidden="true" style={{ height: rowsVirt.padStart }}>
                            <td colSpan={cellCount} className="p-0 border-0" />
                        </tr>
                    )}
                    {rows.slice(rowsVirt.start, rowsVirt.end).map((row, i) => {
                        const r = rowsVirt.start + i;
                        return (
                            <tr key={r} data-row={r} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                {padLeft > 0 && <td aria-hidden="true" />}
                                {visibleColumns.map((col, c) => {
                                    const text = formatCell(row[col.name]);
                                    const mayTruncate = widths[cols.start + c] >= MAX_COLUMN_WIDTH;
                                    return (
                                        <td
                                            key={cols.start + c}
                                            title={mayTruncate ? text : undefined}
                                            className="px-4 py-1.5 border-r whitespace-nowrap overflow-hidden text-ellipsis text-gray-900 border-gray-100 dark:text-gray-100 dark:border-gray-800"
                                        >
                                            {text}
                                        </td>
                                    );
                                })}
                                {padRight > 0 && <td aria-hidden="true" />}
                            </tr>
                        );
                    })}
                    {rowsVirt.padEnd > 0 && (
                        <tr aria-hidden="true" style={{ height: rowsVirt.padEnd }}>
                            <td colSpan={cellCount} className="p-0 border-0" />
                        </tr>
                    )}
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
