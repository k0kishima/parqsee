import React, { RefObject, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { executeSql } from '../api/execute-sql';
import { QueryEditor } from '../components/query-editor';
import { QueryResults, type ChartControls, type ResultMode } from '../components/query-results';
import { IMPLEMENTED_CHART_KINDS } from '../components/query-chart';
import { buildChartModel } from '../lib/chart-data';
import type { ChartKind } from '../lib/chart-types';
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

    const handleExecute = async (query: string) => {
        const run = ++generation.current;
        setIsLoading(true);
        setError(undefined);
        try {
            const data = await executeSql(filePath, query);
            if (run !== generation.current) return;
            const sameSql = lastSql.current === query;
            lastSql.current = query;
            setResult(data);
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
            setResult(undefined);
        } finally {
            if (run === generation.current) setIsLoading(false);
        }
    };

    const model = useMemo(() => (result ? buildChartModel(result, IMPLEMENTED_CHART_KINDS) : null), [result]);
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
            <div className="h-1/3 min-h-[150px] border-b border-gray-200 dark:border-gray-700 shadow-sm relative z-10">
                <QueryEditor onExecute={handleExecute} isLoading={isLoading} isActiveRef={isActiveRef} />
            </div>
            <div className="flex-1 overflow-hidden relative z-0 flex flex-col">
                <QueryResults result={result} error={error} isLoading={isLoading} chart={chart} />
            </div>
        </div>
    );
};
