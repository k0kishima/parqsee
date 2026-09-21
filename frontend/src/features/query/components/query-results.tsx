import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartBar, X } from 'lucide-react';
import { QueryResult } from '../types';
import type { AppliedCondition } from '../lib/result-filter';
import { ResultProfilePanel } from './result-profile';
import type { ChartKind, ChartModel } from '../lib/chart-types';
import { IMPLEMENTED_CHART_KINDS, QueryChart, useProblemText } from './query-chart';
import { useColumnVirtualizer, useRowVirtualizer } from '../../../hooks/useVirtualRange';
import { measureColumnWidths, MAX_COLUMN_WIDTH } from '../../../lib/column-widths';
import { formatCellValue } from '../../../lib/format';
import { useSettings } from '../../../contexts/SettingsContext';
import { ROW_DENSITY_CLASSES } from '../../../lib/settings-storage';

export type ResultMode = 'table' | 'chart';

/** The chart's controls, owned by `QueryView` so they outlive a re-render of the results. */
export interface ChartControls {
    model: ChartModel;
    mode: ResultMode;
    onModeChange: (mode: ResultMode) => void;
    /** The kind drawn: the user's choice while it is available, else the inferred one. */
    kind: ChartKind | null;
    onKindChange: (kind: ChartKind) => void;
    notice: string | null;
}

/**
 * The profile beside the result and the conditions narrowing it, owned by
 * `QueryView`: the rows on screen are the narrowed ones, and the chart is
 * of those same rows.
 */
export interface ProfileControls {
    resultId: string;
    /** The column whose profile is open, by position in the result. */
    openColumn: number | null;
    onOpenColumn: (columnIndex: number | null) => void;
    conditions: AppliedCondition[];
    onNarrow: (conditions: AppliedCondition[]) => void;
    onRemoveCondition: (index: number) => void;
    onClearConditions: () => void;
    /** How many rows the result has before the conditions narrow it. */
    totalRows: number;
    /** The `WHERE` fragment the conditions make, for the profile's own query. */
    filter?: string;
}

interface QueryResultsProps {
    result?: QueryResult;
    error?: string;
    isLoading: boolean;
    chart?: ChartControls;
    profile?: ProfileControls;
}

export const QueryResults: React.FC<QueryResultsProps> = ({ result, error, isLoading, chart, profile }) => {
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
            <div className="p-2 border-b text-xs text-gray-500 flex justify-between gap-4 bg-gray-50 border-primary dark:bg-gray-800">
                <span>
                    {t('viewer.query.rows', { count: result.rows.length })}
                    {result.truncated && (
                        <span className="ml-2 text-amber-700 dark:text-amber-400">
                            {t('viewer.query.truncated', { max: result.max_rows.toLocaleString() })}
                        </span>
                    )}
                </span>
                <span className="flex items-center gap-3">
                    <span>{t('viewer.query.duration', { ms: result.execution_time_ms })}</span>
                    {chart && <ResultModeToggle chart={chart} />}
                </span>
            </div>
            {profile && profile.conditions.length > 0 && (
                <NarrowedBy profile={profile} shown={result.rows.length} />
            )}
            <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                    {chart && chart.mode === 'chart'
                        ? <ChartPane chart={chart} />
                        : <ResultGrid result={result} profile={profile} />}
                </div>
                {profile && profile.openColumn !== null && result.columns[profile.openColumn] && (
                    <ResultProfilePanel
                        resultId={profile.resultId}
                        column={result.columns[profile.openColumn]}
                        columnIndex={profile.openColumn}
                        filter={profile.filter}
                        rows={result.rows.length}
                        truncated={result.truncated}
                        onClose={() => profile.onOpenColumn(null)}
                        onNarrow={profile.onNarrow}
                    />
                )}
            </div>
        </div>
    );
};

/**
 * What the profile narrowed the result to, and the way back. The
 * conditions are the user's own clicks, so each one goes on its own; the
 * SQL in the editor is untouched and says nothing about them, which is
 * why they are named here rather than left for the row count to imply.
 */
const NarrowedBy: React.FC<{ profile: ProfileControls; shown: number }> = ({ profile, shown }) => {
    const { t } = useTranslation();
    return (
        <div className="px-2 py-1 border-b border-primary flex flex-wrap items-center gap-2 text-xs text-secondary">
            <span>{t('viewer.query.result.narrowed', { shown: shown.toLocaleString(), total: profile.totalRows.toLocaleString() })}</span>
            <ul className="flex flex-wrap items-center gap-1">
                {profile.conditions.map((condition, index) => (
                    <li key={`${condition.columnIndex}-${condition.operator}-${condition.sql}`}>
                        <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded border border-secondary bg-tertiary">
                            <span className="font-mono">{condition.label}</span>
                            <button
                                type="button"
                                onClick={() => profile.onRemoveCondition(index)}
                                title={t('viewer.query.result.removeCondition')}
                                aria-label={t('viewer.query.result.removeCondition')}
                                className="p-0.5 rounded text-tertiary hover:text-primary hover:bg-primary"
                            >
                                <X size={11} />
                            </button>
                        </span>
                    </li>
                ))}
            </ul>
            <button
                type="button"
                onClick={profile.onClearConditions}
                className="px-1.5 py-0.5 rounded border border-primary hover:bg-tertiary"
            >
                {t('common.clear')}
            </button>
        </div>
    );
};

const segmentClass = (pressed: boolean) =>
    `px-2 py-0.5 text-xs rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${
        pressed ? 'bg-selected border-blue-300 text-primary dark:border-blue-700' : 'border-primary text-secondary hover:bg-tertiary'
    }`;

/** Table / Chart, and while the chart shows, the kinds that have a renderer. */
const ResultModeToggle: React.FC<{ chart: ChartControls }> = ({ chart }) => {
    const { t } = useTranslation();
    const problemText = useProblemText();
    return (
        <>
            <span role="group" aria-label={t('viewer.query.chart.resultView')} className="inline-flex gap-1">
                {(['table', 'chart'] as const).map(mode => (
                    <button key={mode} type="button" aria-pressed={chart.mode === mode} onClick={() => chart.onModeChange(mode)} className={segmentClass(chart.mode === mode)}>
                        {t(`viewer.query.chart.${mode}`)}
                    </button>
                ))}
            </span>
            {chart.mode === 'chart' && (
                <span role="group" aria-label={t('viewer.query.chart.chartType')} className="inline-flex gap-1">
                    {IMPLEMENTED_CHART_KINDS.map(kind => {
                        const availability = chart.model.availability[kind];
                        const reasonId = `chart-kind-${kind}-reason`;
                        return (
                            <span key={kind} className="inline-flex flex-col">
                                <button
                                    type="button"
                                    aria-pressed={chart.kind === kind}
                                    // Disabled in the accessible sense only: it stays focusable so the reason can be read.
                                    aria-disabled={!availability.available}
                                    aria-describedby={availability.available ? undefined : reasonId}
                                    title={availability.available ? undefined : problemText(availability.reason)}
                                    onClick={() => { if (availability.available) chart.onKindChange(kind); }}
                                    className={`${segmentClass(chart.kind === kind)} ${availability.available ? '' : 'opacity-50 cursor-not-allowed'}`}
                                >
                                    {t(`viewer.query.chart.${kind}`)}
                                </button>
                                {!availability.available && <span id={reasonId} className="sr-only">{problemText(availability.reason)}</span>}
                            </span>
                        );
                    })}
                </span>
            )}
        </>
    );
};

/** The chart, or why there is none: a problem with the result shows in place of the plot, and the table stays a click away. */
const ChartPane: React.FC<{ chart: ChartControls }> = ({ chart }) => {
    const problemText = useProblemText();
    if (chart.kind === null) {
        const problem = chart.model.problem ?? { code: 'noValidPoints' as const };
        return (
            <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-tertiary">
                <p role="status">{problemText(problem)}</p>
            </div>
        );
    }
    return <QueryChart model={chart.model} kind={chart.kind} notice={chart.notice} />;
};

/** Row pitch assumed until the first rows have been measured. */
const DEFAULT_ROW_HEIGHT = 33;

/**
 * The result grid. Like the browse table, only the columns that overlap the
 * scroll viewport are rendered, and because a query can return thousands of
 * rows, only the rows that overlap it as well.
 */
const ResultGrid: React.FC<{ result: QueryResult; profile?: ProfileControls }> = ({ result, profile }) => {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const tbodyRef = useRef<HTMLTableSectionElement>(null);
    const { columns, rows } = result;
    const density = ROW_DENSITY_CLASSES[useSettings().settings.rowDensity];

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

    const headerBg = 'bg-gray-50 border-primary dark:bg-gray-800';

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
                                className={`relative px-4 ${density.queryHeader} font-medium border-b whitespace-nowrap overflow-hidden text-ellipsis text-gray-600 border-primary dark:text-gray-300`}
                            >
                                <div className="flex flex-col">
                                    <span>{col.name}</span>
                                    <span className="text-[10px] text-gray-400 font-normal">{col.data_type}</span>
                                </div>
                                {profile && <ProfileButton profile={profile} name={col.name} columnIndex={cols.start + i} />}
                            </th>
                        ))}
                        {padRight > 0 && <th aria-hidden="true" />}
                    </tr>
                </thead>
                <tbody ref={tbodyRef} className="divide-y divide-subtle">
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
                                            className={`px-4 ${density.queryCell} border-r whitespace-nowrap overflow-hidden text-ellipsis text-gray-900 border-subtle dark:text-gray-100`}
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

/** The chart button on a result column, the same one the browse grid carries. */
const ProfileButton: React.FC<{ profile: ProfileControls; name: string; columnIndex: number }> = ({ profile, name, columnIndex }) => {
    const { t } = useTranslation();
    const open = profile.openColumn === columnIndex;
    return (
        <button
            type="button"
            onClick={() => profile.onOpenColumn(open ? null : columnIndex)}
            aria-pressed={open}
            aria-label={t('viewer.profile.open', { column: name })}
            title={t('viewer.profile.open', { column: name })}
            className={`absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded transition-colors hover:bg-slate-200 dark:hover:bg-gray-600 ${
                open ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 hover:text-slate-600 dark:text-gray-500 dark:hover:text-gray-300'
            }`}
        >
            <ChartBar size={14} />
        </button>
    );
};

const formatCell = (value: unknown): string => formatCellValue(value) ?? 'NULL';
