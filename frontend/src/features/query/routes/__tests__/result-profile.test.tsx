import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubResizeObserver } from '../../../../test/resize-observer';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryView } from '../query-view';
import type { ColumnProfile } from '../../../../bindings/ipc/ColumnProfile';
import type { QueryChartType, QueryResult } from '../../types';

const mockExecuteSql = vi.fn();
const mockProfile = vi.fn();
const mockFilter = vi.fn();
const mockRelease = vi.fn();
vi.mock('../../api/execute-sql', () => ({ executeSql: (...args: unknown[]) => mockExecuteSql(...args) }));
vi.mock('../../api/result-profile', () => ({
  profileQueryColumn: (...args: unknown[]) => mockProfile(...args),
  filterQueryResult: (...args: unknown[]) => mockFilter(...args),
  releaseQueryResult: (...args: unknown[]) => mockRelease(...args),
}));
vi.mock('../../../../contexts/SettingsContext', async () => {
  const { TEST_SETTINGS } = await import('../../../../test/settings');
  return { useSettings: () => ({ settings: TEST_SETTINGS, updateSettings: vi.fn() }) };
});

stubResizeObserver();

const cat: QueryChartType = { kind: 'category' };
const int: QueryChartType = { kind: 'integer' };

const result = (extra: Partial<QueryResult> = {}): QueryResult => ({
  columns: [{ name: 'grp', data_type: 'Utf8', chart_type: cat }, { name: 'n', data_type: 'Int64', chart_type: int }],
  rows: [{ grp: 'a', n: 1 }, { grp: 'b', n: 2 }, { grp: 'a', n: 3 }],
  execution_time_ms: 1,
  truncated: false,
  max_rows: 10_000,
  result_id: 'r1',
  ...extra,
});

const profileOf = (extra: Partial<ColumnProfile> = {}): ColumnProfile => ({
  column: 'grp',
  kind: 'text',
  total_rows: 3,
  null_count: 0,
  distinct_count: 2,
  chart: { shape: 'top_values', values: [{ value: 'a', count: 2 }, { value: 'b', count: 1 }], other: 0 },
  ...extra,
});

const run = async (sql = 'SELECT grp, n FROM t') => {
  const editor = screen.getByRole('textbox');
  await userEvent.clear(editor);
  await userEvent.type(editor, sql);
  await userEvent.click(screen.getByRole('button', { name: /Run|viewer\.query\.run/ }));
};

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteSql.mockResolvedValue(result());
  mockProfile.mockResolvedValue(profileOf());
  mockFilter.mockResolvedValue([{ grp: 'a', n: 1 }, { grp: 'a', n: 3 }]);
});

describe('the profile of a query result', () => {
  it('profiles the column its button names, by position and over the kept result', async () => {
    render(<QueryView filePath="/data/t.parquet" />);
    await run();
    const buttons = await screen.findAllByRole('button', { name: 'viewer.profile.open' });
    await userEvent.click(buttons[1]);
    await waitFor(() => expect(mockProfile).toHaveBeenCalledWith('r1', 1, undefined));
    expect(await screen.findByRole('complementary', { name: 'viewer.profile.title' })).toBeInTheDocument();
  });

  it('narrows the result from a bar, without touching the SQL', async () => {
    render(<QueryView filePath="/data/t.parquet" />);
    await run();
    const buttons = await screen.findAllByRole('button', { name: 'viewer.profile.open' });
    await userEvent.click(buttons[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'a: 2' }));

    // The rows on screen are the narrowed ones, and the editor is untouched.
    await waitFor(() => expect(mockFilter).toHaveBeenCalledWith('r1', "c0 = 'a'"));
    expect(screen.getByRole('textbox')).toHaveValue('SELECT grp, n FROM t');
    expect(await screen.findByText('viewer.query.result.narrowed')).toBeInTheDocument();
    expect(screen.getByText("grp = a")).toBeInTheDocument();
  });

  it('puts every row back when the conditions are cleared', async () => {
    render(<QueryView filePath="/data/t.parquet" />);
    await run();
    const buttons = await screen.findAllByRole('button', { name: 'viewer.profile.open' });
    await userEvent.click(buttons[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'a: 2' }));
    await screen.findByText('viewer.query.result.narrowed');

    await userEvent.click(screen.getByRole('button', { name: 'common.clear' }));
    await waitFor(() => expect(mockFilter).toHaveBeenLastCalledWith('r1', undefined));
    await waitFor(() => expect(screen.queryByText('viewer.query.result.narrowed')).not.toBeInTheDocument());
  });

  it('says a truncated result is only the rows that came back', async () => {
    mockExecuteSql.mockResolvedValue(result({ truncated: true }));
    render(<QueryView filePath="/data/t.parquet" />);
    await run();
    const buttons = await screen.findAllByRole('button', { name: 'viewer.profile.open' });
    await userEvent.click(buttons[0]);
    expect(await screen.findByText('viewer.query.result.partialProfile')).toBeInTheDocument();
  });

  // A new result is a new set of rows: conditions from the old one would
  // name columns the new one may not have.
  it('drops the panel and the conditions when the query runs again', async () => {
    render(<QueryView filePath="/data/t.parquet" />);
    await run();
    const buttons = await screen.findAllByRole('button', { name: 'viewer.profile.open' });
    await userEvent.click(buttons[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'a: 2' }));
    await screen.findByText('viewer.query.result.narrowed');

    mockExecuteSql.mockResolvedValue(result({ result_id: 'r2' }));
    await run('SELECT grp FROM t');
    await waitFor(() => expect(screen.queryByText('viewer.query.result.narrowed')).not.toBeInTheDocument());
    expect(screen.queryByRole('complementary', { name: 'viewer.profile.title' })).not.toBeInTheDocument();
    // The rows of the result it replaced are let go.
    expect(mockRelease).toHaveBeenCalledWith('r1');
  });

  it('offers no profile for a result the backend could not keep', async () => {
    mockExecuteSql.mockResolvedValue(result({ result_id: null }));
    render(<QueryView filePath="/data/t.parquet" />);
    await run();
    await screen.findByText(/viewer\.query\.rows/);
    expect(screen.queryAllByRole('button', { name: 'viewer.profile.open' })).toHaveLength(0);
  });
});
