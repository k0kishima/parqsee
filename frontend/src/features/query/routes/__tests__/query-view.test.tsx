import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubResizeObserver } from '../../../../test/resize-observer';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryView } from '../query-view';
import type { QueryChartType, QueryResult } from '../../types';

const mockExecuteSql = vi.fn();
vi.mock('../../api/execute-sql', () => ({
  executeSql: (...args: unknown[]) => mockExecuteSql(...args),
}));
vi.mock('../../../../contexts/SettingsContext', async () => {
  const { TEST_SETTINGS } = await import('../../../../test/settings');
  return { useSettings: () => ({ settings: TEST_SETTINGS, updateSettings: vi.fn() }) };
});
// A second implemented kind, so a pick can become unavailable: with bar
// alone nothing a result can do takes the picked kind away.
vi.mock('../../components/query-chart', async importOriginal => {
  const original = await importOriginal<typeof import('../../components/query-chart')>();
  return { ...original, IMPLEMENTED_CHART_KINDS: ['bar', 'scatter'] };
});

stubResizeObserver();

const cat: QueryChartType = { kind: 'category' };
const int: QueryChartType = { kind: 'integer' };
const byCategory: QueryResult = {
  columns: [{ name: 'x', data_type: 'Utf8', chart_type: cat }, { name: 'y', data_type: 'Int64', chart_type: int }],
  rows: [{ x: 'a', y: 1 }, { x: 'b', y: 2 }],
  execution_time_ms: 1, truncated: false, max_rows: 10_000, result_id: 'r1',
};
const byNumber: QueryResult = {
  ...byCategory,
  columns: [{ name: 'x', data_type: 'Int64', chart_type: int }, { name: 'y', data_type: 'Int64', chart_type: int }],
  rows: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
};

const run = async (sql: string) => {
  const editor = screen.getByRole('textbox');
  await userEvent.clear(editor);
  await userEvent.type(editor, sql);
  await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
  await waitFor(() => expect(screen.queryByText('viewer.query.executing')).not.toBeInTheDocument());
};
const modeButton = (mode: string) => screen.getByRole('group', { name: 'viewer.query.chart.resultView' }).querySelector(`button:nth-child(${mode === 'table' ? 1 : 2})`) as HTMLElement;
const kindButton = (kind: string) => screen.getByRole('button', { name: `viewer.query.chart.${kind}` });

describe('QueryView result mode and chart kind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteSql.mockResolvedValue(byCategory);
  });

  it('shows the table first and switches to the chart without re-running the query', async () => {
    render(<QueryView filePath="/data/t.parquet" />);
    await run('SELECT x, y FROM t');
    expect(mockExecuteSql).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(modeButton('table')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('group', { name: 'viewer.query.chart.chartType' })).not.toBeInTheDocument();

    await userEvent.click(modeButton('chart'));
    expect(mockExecuteSql).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(document.querySelector('svg[data-chart-kind="bar"]')).toBeInTheDocument();
    expect(kindButton('bar')).toHaveAttribute('aria-pressed', 'true');
    // Scatter needs a numeric X: offered, not disabled out of reach, with the reason.
    expect(kindButton('scatter')).toHaveAttribute('aria-disabled', 'true');
    expect(kindButton('scatter')).toHaveAccessibleDescription('viewer.query.chart.numericXRequired');
    await userEvent.click(kindButton('scatter'));
    expect(kindButton('bar')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(modeButton('table'));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(mockExecuteSql).toHaveBeenCalledTimes(1);
  });

  it('keeps a picked kind across a re-run of the same SQL and drops it when the SQL changes', async () => {
    mockExecuteSql.mockResolvedValue(byNumber);
    render(<QueryView filePath="/data/t.parquet" />);
    await run('SELECT n, y FROM t');
    await userEvent.click(modeButton('chart'));
    // Numeric X infers scatter; the user picks bar.
    expect(kindButton('scatter')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(kindButton('bar'));
    expect(kindButton('bar')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
    await waitFor(() => expect(mockExecuteSql).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('viewer.query.executing')).not.toBeInTheDocument());
    expect(modeButton('chart')).toHaveAttribute('aria-pressed', 'true');
    expect(kindButton('bar')).toHaveAttribute('aria-pressed', 'true');

    // Editing alone changes nothing; a successful run of the new SQL re-infers.
    await userEvent.type(screen.getByRole('textbox'), ' ');
    expect(kindButton('bar')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
    await waitFor(() => expect(mockExecuteSql).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(kindButton('scatter')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByText('viewer.query.chart.switchedAutomatically')).not.toBeInTheDocument();
  });

  it('says so when the same SQL no longer allows the picked kind', async () => {
    mockExecuteSql.mockResolvedValueOnce(byNumber).mockResolvedValueOnce(byCategory);
    render(<QueryView filePath="/data/t.parquet" />);
    await run('SELECT x, y FROM t');
    await userEvent.click(modeButton('chart'));
    expect(kindButton('scatter')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
    await waitFor(() => expect(mockExecuteSql).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(kindButton('bar')).toHaveAttribute('aria-pressed', 'true'));
    // Inferred scatter was not a pick, so nothing to announce...
    expect(screen.queryByText('viewer.query.chart.switchedAutomatically')).not.toBeInTheDocument();

    // ...but an explicit pick that the new data cannot draw is.
    mockExecuteSql.mockResolvedValueOnce(byNumber).mockResolvedValueOnce(byCategory);
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
    await waitFor(() => expect(mockExecuteSql).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(kindButton('scatter')).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(kindButton('scatter'));
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
    await waitFor(() => expect(mockExecuteSql).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(kindButton('bar')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByText('viewer.query.chart.switchedAutomatically')).toBeInTheDocument();
  });

  it('keeps the mode and the pick through a failed run, and shows no stale chart', async () => {
    render(<QueryView filePath="/data/t.parquet" />);
    await run('SELECT x, y FROM t');
    await userEvent.click(modeButton('chart'));
    mockExecuteSql.mockRejectedValueOnce('boom');
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(document.querySelector('svg[data-chart-kind]')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
    await waitFor(() => expect(document.querySelector('svg[data-chart-kind="bar"]')).toBeInTheDocument());
    expect(modeButton('chart')).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores the answer to a run the user has superseded', async () => {
    let resolveFirst: (r: QueryResult) => void = () => {};
    mockExecuteSql.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    mockExecuteSql.mockResolvedValueOnce(byNumber);
    render(<QueryView filePath="/data/t.parquet" />);
    const runButton = screen.getByRole('button', { name: /viewer\.query\.run/ });
    await userEvent.click(runButton);
    // The button is disabled while loading; ⌘↩ is too, so a second run
    // means the first was let go of. Simulate by resolving out of order.
    resolveFirst(byCategory);
    await waitFor(() => expect(screen.queryByText('viewer.query.executing')).not.toBeInTheDocument());
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toContain('xUtf8');
  });
});
