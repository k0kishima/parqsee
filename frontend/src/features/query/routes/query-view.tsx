import React, { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { executeSql } from '../api/execute-sql';
import { filterQueryResult, releaseQueryResult } from '../api/result-profile';
import { QueryEditor } from '../components/query-editor';
import { QueryResults, type ChartControls, type ProfileControls, type ResultMode } from '../components/query-results';
import { IMPLEMENTED_CHART_KINDS } from '../components/query-chart';
import { buildChartModel } from '../lib/chart-data';
import type { ChartKind } from '../lib/chart-types';
import { QueryResult } from '../types';
import { applyConditions, filterSqlOf, type AppliedCondition } from '../lib/result-filter';
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
    const { t } = useTranslation();
    const [result, setResult] = useState<QueryResult | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [isLoading, setIsLoading] = useState(false);

    // The chart's settings live as long as this view — and this view as
    // long as its tab, like the SQL text. They are not part of the saved
    // session: neither the SQL nor its result is, so a restored "chart"
    // mode would have nothing to show.
    const [resultMode, setResultMode] = useState<ResultMode>('table');
    // The user's pick of kind. Null means the inferred one. It survives a
    // re-run of the same SQL and is dropped when the SQL changes (a
    // different query is a different chart) or when the new result cannot
    // draw it, which `notice` says.
    const [chartOverride, setChartOverride] = useState<ChartKind | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const lastSql = useRef<string | null>(null);
    // Answers to a run the user has since superseded are dropped.
    const generation = useRef(0);

    // The profile beside the result, and what it narrowed the result to.
    // A new result is a new set of rows, so both start again with it:
    // conditions from the old one would name columns the new one may not
    // have, and would claim a row count nothing on screen produced.
    const [profileColumn, setProfileColumn] = useState<number | null>(null);
    const [conditions, setConditions] = useState<AppliedCondition[]>([]);
    const [narrowedRows, setNarrowedRows] = useState<Record<string, unknown>[] | null>(null);
    const [narrowError, setNarrowError] = useState<string | undefined>();
    // Answers to a narrow the user has since superseded are dropped, the
    // same way a superseded run's are.
    const narrowSeq = useRef(0);

    // The backend holds the rows of every result it is asked to keep. The
    // webview is what knows a result is finished with: a re-run replaced
    // it, its answer was superseded, or the tab closed. The store's own
    // caps collect what a missed call leaves behind.
    const kept = useRef<string | null>(null);
    const keep = useCallback((next: QueryResult | undefined) => {
        const id = next?.result_id ?? null;
        if (kept.current !== null && kept.current !== id) releaseQueryResult(kept.current);
        kept.current = id;
    }, []);
    // Nothing will render again: the kept result goes, and a run still in
    // flight must not take its place — with `kept` cleared it would
    // release the result twice and leave its own rows to the caps, so the
    // generation moves on and its answer is released as superseded.
    useEffect(() => () => {
        generation.current += 1;
        if (kept.current !== null) releaseQueryResult(kept.current);
        kept.current = null;
    }, []);

    const handleExecute = async (query: string) => {
        const run = ++generation.current;
        setIsLoading(true);
        setError(undefined);
        try {
            const data = await executeSql(filePath, query);
            if (run !== generation.current) {
                // A run the user superseded: its rows are held by the
                // backend and nothing will ask about them again.
                if (data.result_id) releaseQueryResult(data.result_id);
                return;
            }
            const sameSql = lastSql.current === query;
            lastSql.current = query;
            keep(data);
            setResult(data);
            setProfileColumn(null);
            setConditions([]);
            setNarrowedRows(null);
            setNarrowError(undefined);
            narrowSeq.current += 1;
            setNotice(null);
            if (!sameSql) {
                setChartOverride(null);
            } else if (chartOverride !== null) {
                const model = buildChartModel(data, IMPLEMENTED_CHART_KINDS);
                if (!model.availability[chartOverride].available) {
                    setChartOverride(null);
                    setNotice(t('viewer.query.chart.switchedAutomatically'));
                }
            }
        } catch (err) {
            if (run !== generation.current) return;
            console.error(err);
            setError(toErrorMessage(err));
            keep(undefined);
            setResult(undefined);
            setProfileColumn(null);
            setConditions([]);
            setNarrowedRows(null);
            narrowSeq.current += 1;
        } finally {
            if (run === generation.current) setIsLoading(false);
        }
    };

    // What is on screen: the rows the conditions keep, so the grid, the
    // chart and the row count all describe one set of rows.
    const shown = useMemo(
        () => (result && narrowedRows ? { ...result, rows: narrowedRows } : result),
        [result, narrowedRows],
    );

    /**
     * Narrow the result to the rows `next` keeps. An answer is guarded by
     * both generations it belongs to: the click it answers and the result
     * it was asked of. A later click, or a new result, makes it
     * meaningless — and taking it would be worse than losing it. Its rows
     * are the old result's, so they would be laid out under the new
     * result's columns with no condition named above them; and its
     * failure, a result the backend has already let go of, would be shown
     * as the error of a result that is fine, hiding it with no way back
     * but another run.
     */
    const narrow = useCallback(async (next: AppliedCondition[], resultId: string) => {
        const seq = ++narrowSeq.current;
        const stale = () => seq !== narrowSeq.current || kept.current !== resultId;
        setConditions(next);
        try {
            const rows = await filterQueryResult(resultId, filterSqlOf(next));
            if (stale()) return;
            setNarrowedRows(next.length === 0 ? null : rows);
            setNarrowError(undefined);
        } catch (err) {
            if (stale()) return;
            console.error(err);
            setNarrowError(toErrorMessage(err));
        }
    }, []);

    const profile: ProfileControls | undefined = result?.result_id
        ? {
            resultId: result.result_id,
            openColumn: profileColumn,
            onOpenColumn: setProfileColumn,
            conditions,
            onNarrow: next => { void narrow(applyConditions(conditions, next), result.result_id!); },
            onRemoveCondition: index => { void narrow(conditions.filter((_, i) => i !== index), result.result_id!); },
            onClearConditions: () => { void narrow([], result.result_id!); },
            totalRows: result.rows.length,
            filter: filterSqlOf(conditions),
        }
        : undefined;

    const model = useMemo(() => (shown ? buildChartModel(shown, IMPLEMENTED_CHART_KINDS) : null), [shown]);
    const onKindChange = useCallback((kind: ChartKind) => { setChartOverride(kind); setNotice(null); }, []);
    const chart: ChartControls | undefined = model
        ? {
            model,
            mode: resultMode,
            onModeChange: setResultMode,
            kind: chartOverride !== null && model.availability[chartOverride].available ? chartOverride : model.inferred,
            onKindChange,
            notice,
        }
        : undefined;

    return (
        <div className="flex flex-col h-full bg-slate-50 dark:bg-gray-900">
            <div className="h-1/3 min-h-[150px] border-b border-primary relative z-10">
                <QueryEditor onExecute={handleExecute} isLoading={isLoading} isActiveRef={isActiveRef} />
            </div>
            <div className="flex-1 overflow-hidden relative z-0 flex flex-col">
                <QueryResults result={shown} error={error ?? narrowError} isLoading={isLoading} chart={chart} profile={profile} />
            </div>
        </div>
    );
};
