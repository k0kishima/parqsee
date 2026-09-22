import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubResizeObserver } from '../../../../test/resize-observer';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryView } from '../query-view';
import { dispatchAppCommand } from '../../../../lib/app-commands';
import type { ColumnCounts } from '../../../../bindings/ipc/ColumnCounts';
import type { ProfileChart } from '../../../../bindings/ipc/ProfileChart';
import type { QueryChartType, QueryResult } from '../../types';

const mockExecuteSql = vi.fn();
const mockCancel = vi.fn();
const mockCounts = vi.fn();
const mockChart = vi.fn();
const mockFilter = vi.fn();
const mockRelease = vi.fn();
vi.mock('../../api/execute-sql', () => {
  let issued = 0;
  return {
    executeSql: (...args: unknown[]) => mockExecuteSql(...args),
    cancelQuery: (...args: unknown[]) => mockCancel(...args),
    nextQueryRequestId: () => `q-${++issued}`,
  };
});
vi.mock('../../api/result-profile', () => ({
  profileQueryColumnCounts: (...args: unknown[]) => mockCounts(...args),
  profileQueryColumnChart: (...args: unknown[]) => mockChart(...args),
  filterQueryResult: (...args: unknown[]) => mockFilter(...args),
  releaseQueryResult: (...args: unknown[]) => mockRelease(...args),
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
const headers = () => screen.getAllByRole('columnheader').map(h => h.textContent);
/** The id the n-th run was given, which is what its cancel is asked by. */
const requestIdOfRun = (n: number) => mockExecuteSql.mock.calls[n][2];
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

  it('stops the run in flight for a re-run and ignores its answer', async () => {
    const first = deferred<QueryResult>();
    mockExecuteSql.mockImplementationOnce(() => first.promise);
    mockExecuteSql.mockResolvedValueOnce(byNumber);
    render(<QueryView filePath="/data/t.parquet" />);
    const runButton = screen.getByRole('button', { name: /viewer\.query\.run/ });
    await userEvent.click(runButton);
    await userEvent.click(runButton);

    // Stopped in the backend by the id it was given, not only ignored here.
    expect(mockExecuteSql).toHaveBeenCalledTimes(2);
    expect(mockCancel).toHaveBeenCalledWith(requestIdOfRun(0));
    expect(requestIdOfRun(1)).not.toBe(requestIdOfRun(0));

    first.resolve(byCategory);
    await waitFor(() => expect(screen.queryByText('viewer.query.executing')).not.toBeInTheDocument());
    expect(headers()).toContain('xInt64');
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it('runs again on ⌘↩ during a run instead of dropping the key', async () => {
    const first = deferred<QueryResult>();
    mockExecuteSql.mockImplementationOnce(() => first.promise);
    mockExecuteSql.mockResolvedValueOnce(byNumber);
    render(<QueryView filePath="/data/t.parquet" />);
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));

    act(() => dispatchAppCommand('run-query'));
    await waitFor(() => expect(mockExecuteSql).toHaveBeenCalledTimes(2));
    expect(mockCancel).toHaveBeenCalledWith(requestIdOfRun(0));

    first.resolve(byCategory);
    await waitFor(() => expect(screen.queryByText('viewer.query.executing')).not.toBeInTheDocument());
    expect(headers()).toContain('xInt64');
  });

  it('stops the run on Stop or ⌘. and keeps the result on screen', async () => {
    render(<QueryView filePath="/data/t.parquet" />);
    // Nothing to stop yet: the key does nothing, and the button is not there.
    act(() => dispatchAppCommand('stop-query'));
    expect(mockCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /viewer\.query\.stop/ })).not.toBeInTheDocument();
    await run('SELECT x, y FROM t');

    const pending = deferred<QueryResult>();
    mockExecuteSql.mockImplementationOnce(() => pending.promise);
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));
    expect(screen.getByText('viewer.query.executing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.stop/ }));

    expect(mockCancel).toHaveBeenCalledWith(requestIdOfRun(1));
    expect(screen.queryByText('viewer.query.executing')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /viewer\.query\.stop/ })).not.toBeInTheDocument();
    expect(headers()).toContain('xUtf8');

    // The backend answers a stopped run with a refusal; it is not an error
    // the user wants to read, and the result before it stays.
    pending.reject('The profile was superseded by a newer one');
    await act(async () => {});
    expect(screen.queryByText(/superseded/)).not.toBeInTheDocument();
    expect(headers()).toContain('xUtf8');

    // ⌘. does the same for a run the key started.
    const again = deferred<QueryResult>();
    mockExecuteSql.mockImplementationOnce(() => again.promise);
    act(() => dispatchAppCommand('run-query'));
    await waitFor(() => expect(screen.getByText('viewer.query.executing')).toBeInTheDocument());
    act(() => dispatchAppCommand('stop-query'));
    expect(mockCancel).toHaveBeenCalledWith(requestIdOfRun(2));
    expect(screen.queryByText('viewer.query.executing')).not.toBeInTheDocument();
  });
});

// The second result: different columns and a different id, so a row or a
// header on screen says which result produced it.
const replacement: QueryResult = {
  columns: [{ name: 'z', data_type: 'Utf8', chart_type: cat }, { name: 'y', data_type: 'Int64', chart_type: int }],
  rows: [{ z: 'q', y: 9 }],
  execution_time_ms: 1, truncated: false, max_rows: 10_000, result_id: 'r2',
};
const counts: ColumnCounts = {
  column: 'x', kind: 'text', total_rows: 2, null_count: 0, distinct_count: 2, distinct_approximate: false,
};
const topValues: ProfileChart = {
  shape: 'top_values', values: [{ value: 'a', count: 1 }, { value: 'b', count: 1 }], other: 0,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Open the profile of the first column and click the bar of `value`. */
const clickBar = async (value: string, count: number) => {
  await userEvent.click((await screen.findAllByRole('button', { name: 'viewer.profile.open' }))[0]);
  await userEvent.click(await screen.findByRole('button', { name: `${value}: ${count}` }));
};

describe('a narrow still in flight when a new run lands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteSql.mockResolvedValue(byCategory);
    mockCounts.mockResolvedValue(counts);
    mockChart.mockResolvedValue(topValues);
  });

  /** Run r1, click a bar whose answer is held back, then run r2. */
  const narrowThenRerun = async () => {
    const pending = deferred<Record<string, unknown>[]>();
    render(<QueryView filePath="/data/t.parquet" />);
    await run('SELECT x, y FROM t');
    mockFilter.mockReturnValueOnce(pending.promise);
    await clickBar('a', 1);
    await waitFor(() => expect(mockFilter).toHaveBeenCalledTimes(1));

    mockExecuteSql.mockResolvedValue(replacement);
    await run('SELECT z, y FROM t');
    await waitFor(() => expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toContain('zUtf8'));
    return pending;
  };

  it('does not hide the new result when the late narrow is rejected', async () => {
    const pending = await narrowThenRerun();
    await act(async () => {
      pending.reject('This result is no longer available. Run the query again.');
      await pending.promise.catch(() => {});
    });
    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toContain('zUtf8');
  });

  it('does not replace the new rows when the late narrow resolves', async () => {
    const pending = await narrowThenRerun();
    await act(async () => {
      pending.resolve([{ x: 'a', y: 111 }]);
      await pending.promise;
    });
    expect(screen.getByText('q')).toBeInTheDocument();
    expect(screen.queryByText('111')).not.toBeInTheDocument();
    expect(screen.queryByText('viewer.query.result.narrowed')).not.toBeInTheDocument();
  });

  it('keeps the later of two narrows answered out of order', async () => {
    const first = deferred<Record<string, unknown>[]>();
    const second = deferred<Record<string, unknown>[]>();
    render(<QueryView filePath="/data/t.parquet" />);
    await run('SELECT x, y FROM t');

    mockFilter.mockReturnValueOnce(first.promise);
    await clickBar('a', 1);
    // A value closes the panel, so the second click opens it again.
    mockFilter.mockReturnValueOnce(second.promise);
    await clickBar('b', 1);
    await waitFor(() => expect(mockFilter).toHaveBeenCalledTimes(2));

    await act(async () => { second.resolve([{ x: 'b', y: 222 }]); await second.promise; });
    await act(async () => { first.resolve([{ x: 'a', y: 111 }]); await first.promise; });

    expect(screen.getByText('x = b')).toBeInTheDocument();
    expect(screen.queryByText('x = a')).not.toBeInTheDocument();
    expect(screen.getByText('222')).toBeInTheDocument();
    expect(screen.queryByText('111')).not.toBeInTheDocument();
  });
});

describe('release accounting when the tab closes mid-run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteSql.mockResolvedValue(byCategory);
  });

  it('releases the result it held and the answer that arrives after, each once', async () => {
    const pending = deferred<QueryResult>();
    const { unmount } = render(<QueryView filePath="/data/t.parquet" />);
    await run('SELECT x, y FROM t');
    mockExecuteSql.mockReturnValueOnce(pending.promise);
    await userEvent.click(screen.getByRole('button', { name: /viewer\.query\.run/ }));

    unmount();
    await act(async () => { pending.resolve(replacement); await pending.promise; });

    expect(mockRelease.mock.calls.map(call => call[0]).sort()).toEqual(['r1', 'r2']);
  });
});
