import React, { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cancelQuery, executeSql, nextQueryRequestId } from '../api/execute-sql';
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
    // The run the backend is on, by the id it can be stopped by. A run the
    // user supersedes or stops is cancelled there and not only ignored
    // here: the session scans a single partition, so until it ended it
    // would hold the file's reads for an answer nobody will look at.
    const inFlight = useRef<string | null>(null);

    // The profile beside the result, and what it narrowed the result to.
    // A new result is a new set of rows, so both start again with it:
    // conditions from the old one would name columns the new one may not
    // have, and would claim a row count nothing on screen produced.
    const [profileColumn, setProfileColumn] = useState<number | null>(null);
    // Conditions describe only rows that have arrived successfully. Keeping
    // them together prevents a failed request from relabelling older rows.
    const [narrowed, setNarrowed] = useState<{
        conditions: AppliedCondition[];
        rows: Record<string, unknown>[];
    } | null>(null);
    const conditions = narrowed?.conditions ?? [];
    const requestedConditions = useRef<AppliedCondition[]>([]);
    const [isNarrowing, setIsNarrowing] = useState(false);
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
    // Replacing or discarding a result also invalidates its profile and
    // pending narrowing requests. Keep that transition in one place.
    const replaceResult = (next: QueryResult | undefined) => {
        keep(next);
        setResult(next);
        setProfileColumn(null);
        setNarrowed(null);
        requestedConditions.current = [];
        setIsNarrowing(false);
        setNarrowError(undefined);
        narrowSeq.current += 1;
    };
    // Nothing will render again: the kept result goes, and a run still in
    // flight must not take its place — with `kept` cleared it would
    // release the result twice and leave its own rows to the caps, so the
    // generation moves on and its answer is released as superseded.
    useEffect(() => () => {
        generation.current += 1;
        if (kept.current !== null) releaseQueryResult(kept.current);
        kept.current = null;
        if (inFlight.current !== null) void cancelQuery(inFlight.current);
        inFlight.current = null;
    }, []);

    const handleExecute = async (query: string) => {
        const run = ++generation.current;
        if (inFlight.current !== null) void cancelQuery(inFlight.current);
        const requestId = nextQueryRequestId();
        inFlight.current = requestId;
        setIsLoading(true);
        setError(undefined);
        try {
            const data = await executeSql(filePath, query, requestId);
            if (run !== generation.current) {
                // A run the user superseded: its rows are held by the
                // backend and nothing will ask about them again.
                if (data.result_id) releaseQueryResult(data.result_id);
                return;
            }
            const sameSql = lastSql.current === query;
            lastSql.current = query;
            replaceResult(data);
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
            replaceResult(undefined);
        } finally {
            if (run === generation.current) {
                inFlight.current = null;
                setIsLoading(false);
            }
        }
    };

    /**
     * Stop the run in flight. What is on screen stays: the result of the
     * run before it was never replaced, and an error the stopped run would
     * have shown is not one the user wants to read.
     */
    const handleStop = () => {
        if (inFlight.current === null) return;
        generation.current += 1;
        void cancelQuery(inFlight.current);
        inFlight.current = null;
        setIsLoading(false);
    };

    // What is on screen: the rows the conditions keep, so the grid, the
    // chart and the row count all describe one set of rows.
    const shown = useMemo(
        () => (result && narrowed ? { ...result, rows: narrowed.rows } : result),
        [result, narrowed],
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
        requestedConditions.current = next;
        setNarrowError(undefined);
        // The original rows already live in the webview. Clearing must
        // still work after the backend evicts this result to meet its cap.
        if (next.length === 0) {
            setNarrowed(null);
            setIsNarrowing(false);
            return;
        }
        setIsNarrowing(true);
        try {
            const rows = await filterQueryResult(resultId, filterSqlOf(next));
            if (stale()) return;
            setNarrowed({ conditions: next, rows });
            setNarrowError(undefined);
        } catch (err) {
            if (stale()) return;
            console.error(err);
            requestedConditions.current = narrowed?.conditions ?? [];
            setNarrowError(toErrorMessage(err));
        } finally {
            if (!stale()) setIsNarrowing(false);
        }
    }, [narrowed]);

    const profile: ProfileControls | undefined = result?.result_id
        ? {
            resultId: result.result_id,
            openColumn: profileColumn,
            onOpenColumn: setProfileColumn,
            conditions,
            isNarrowing,
            onNarrow: next => { void narrow(applyConditions(requestedConditions.current, next), result.result_id!); },
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
                <QueryEditor onExecute={handleExecute} onStop={handleStop} isLoading={isLoading} isActiveRef={isActiveRef} />
            </div>
            <div className="flex-1 overflow-hidden relative z-0 flex flex-col">
                <QueryResults result={shown} error={error} narrowError={narrowError} isLoading={isLoading} chart={chart} profile={profile} />
            </div>
        </div>
    );
};
