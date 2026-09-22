import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { dispatchAppCommand } from '../../../../lib/app-commands';
import userEvent from '@testing-library/user-event';
import { DataViewer } from '../data-viewer';

const mockOpenParquetFile = vi.fn();
const mockReadParquetData = vi.fn();
const mockCountParquetData = vi.fn();
const mockEvictCache = vi.fn();
const mockProfileCounts = vi.fn();
const mockProfileChart = vi.fn();
vi.mock('../../api', () => ({
  openParquetFile: (...args: unknown[]) => mockOpenParquetFile(...args),
  readParquetData: (...args: unknown[]) => mockReadParquetData(...args),
  countParquetData: (...args: unknown[]) => mockCountParquetData(...args),
  profileColumnCounts: (...args: unknown[]) => mockProfileCounts(...args),
  profileColumnChart: (...args: unknown[]) => mockProfileChart(...args),
  // The real wrapper swallows the rejection; the double must too, or the
  // "could not be evicted" case below would test an impossible state.
  // api/__tests__/evict-cache-quietly.test.ts pins the real one.
  evictCacheQuietly: (...args: unknown[]) =>
    mockEvictCache(...args).catch((err: unknown) => console.error('Failed to evict cache:', err)),
}));

vi.mock('../../../../contexts/SettingsContext', async () => {
  const { TEST_SETTINGS } = await import('../../../../test/settings');
  return { useSettings: () => ({ settings: TEST_SETTINGS, updateSettings: vi.fn() }) };
});

const metadata = {
  num_rows: 100,
  num_columns: 1,
  columns: [{ name: 'id', column_type: 'INT64', kind: 'integer' as const, physical_type: 'INT64' }],
};

/** The page number input (the filter value input is found by placeholder). */
const pageInput = () =>
  screen.getAllByRole('textbox').find(el => (el as HTMLInputElement).inputMode === 'numeric') as HTMLInputElement;

const applyFilter = async (value: string) => {
  const user = userEvent.setup();
  // The bar opens with no column picked, so a condition is built left to
  // right; a value on its own applies nothing.
  await user.selectOptions(screen.getAllByRole('combobox')[0], 'id');
  await user.clear(screen.getByPlaceholderText('viewer.filterValuePlaceholder'));
  await user.type(screen.getByPlaceholderText('viewer.filterValuePlaceholder'), value);
  await user.click(screen.getByText('common.apply'));
};

/**
 * A backend that answers every call, so each suite below only sets up what
 * it is actually about. `clearAllMocks` comes first: a `mockResolvedValueOnce`
 * left over from one test would otherwise answer the next one's first call.
 */
beforeEach(() => {
  vi.clearAllMocks();
  mockOpenParquetFile.mockResolvedValue(metadata);
  mockReadParquetData.mockResolvedValue([{ id: 1 }]);
  mockCountParquetData.mockResolvedValue(5);
  mockEvictCache.mockResolvedValue(undefined);
});

/** The viewer on screen with its first page loaded. */
const renderViewer = async (initialState?: Parameters<typeof DataViewer>[0]['initialState']) => {
  render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} initialState={initialState} />);
  await waitFor(() => expect(mockReadParquetData).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
};

describe('DataViewer failed-load rollback', () => {
  it('rolls the filter back when the filtered load fails, without an echo reload', async () => {
    await renderViewer();
    mockCountParquetData.mockRejectedValueOnce('boom: bad filter');

    await applyFilter('5');

    // Banner up, and the failed filter was rolled back: no clear (✕) button,
    // and the grid was not re-read for the rollback (the rows on screen are
    // already the rolled-back state).
    expect(await screen.findByText('viewer.dataError')).toBeInTheDocument();
    expect(screen.getByText('boom: bad filter')).toBeInTheDocument();
    expect(screen.queryByTitle('common.clear')).not.toBeInTheDocument();
    expect(mockReadParquetData).toHaveBeenCalledTimes(1);

    // A corrected filter recovers: banner clears and the filter applies.
    await applyFilter('7');
    await waitFor(() => expect(screen.queryByText('viewer.dataError')).not.toBeInTheDocument());
    expect(screen.getByTitle('common.clear')).toBeInTheDocument();
    expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '"id" = 7', null);
  });

  it('rolls the page back when a page read fails', async () => {
    await renderViewer();
    mockReadParquetData.mockImplementation((_path, offset) =>
      offset === 0 ? Promise.resolve([{ id: 1 }]) : Promise.reject('boom: bad page')
    );

    await userEvent.click(screen.getByText('viewer.pagination.next'));

    // Nothing was asked of the file but another page, so the banner says the
    // rows could not be loaded — not that a condition could not be run.
    expect(await screen.findByText('viewer.loadError')).toBeInTheDocument();
    expect(screen.queryByText('viewer.dataError')).not.toBeInTheDocument();
    await waitFor(() => expect(pageInput().value).toBe('1'));
    // offset 0 (initial) + offset 50 (failed) — no echo reload of page 1.
    expect(mockReadParquetData).toHaveBeenCalledTimes(2);
  });

  // A file replaced under the tab: the backend refuses every read of it,
  // while the filter on screen is perfectly good.
  it('does not blame the filter when the file itself was refused', async () => {
    mockCountParquetData.mockResolvedValue(500);
    await renderViewer();
    await applyFilter('5');
    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '"id" = 5', null));

    mockReadParquetData.mockRejectedValueOnce('The file changed while reading it. Refresh and try again.');
    await userEvent.click(screen.getByText('viewer.pagination.next'));

    expect(await screen.findByText('viewer.loadError')).toBeInTheDocument();
    expect(screen.queryByText('viewer.dataError')).not.toBeInTheDocument();
    expect(screen.getByText('The file changed while reading it. Refresh and try again.')).toBeInTheDocument();
  });

  it('does not start a page read when an older filter count finishes last', async () => {
    await renderViewer();
    let finishOldCount!: (count: number) => void;
    mockCountParquetData.mockReturnValueOnce(new Promise<number>(resolve => { finishOldCount = resolve; }));
    await applyFilter('5');
    await waitFor(() => expect(mockCountParquetData).toHaveBeenCalledWith('/data/test.parquet', '"id" = 5'));

    await applyFilter('7');
    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '"id" = 7', null));
    await act(async () => { finishOldCount(5); });

    expect(mockReadParquetData).toHaveBeenCalledTimes(2);
    expect(mockReadParquetData).not.toHaveBeenCalledWith('/data/test.parquet', 0, 50, '"id" = 5', null);
    expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument();
  });

  it('drops a restored filter the file refuses and shows the plain page under a banner', async () => {
    // The file was rewritten while the tab was closed: the saved filter
    // names a column it no longer has.
    mockCountParquetData.mockRejectedValueOnce('boom: No field named gone');
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} initialState={{ activeFilter: '"gone" = 1' }} />);

    // The plain first page loaded, and it is the only read that was made:
    // the refused count never reached one.
    await waitFor(() => expect(mockReadParquetData).toHaveBeenCalledTimes(1));
    expect(mockReadParquetData).toHaveBeenCalledWith('/data/test.parquet', 0, 50, '', null);
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());

    // The tab is a working tab, not an error screen, and the banner says
    // what was dropped.
    expect(screen.queryByText('viewer.error')).not.toBeInTheDocument();
    expect(screen.getByText('viewer.filterDropped')).toBeInTheDocument();
    expect(screen.getByText('boom: No field named gone')).toBeInTheDocument();
    expect(screen.getByText('"gone" = 1')).toBeInTheDocument();
    expect(screen.getByText('common.apply')).toBeInTheDocument();
  });

  it('drops a filter the file no longer has on Refresh and keeps the tab', async () => {
    await renderViewer();
    await applyFilter('5');
    await waitFor(() => expect(mockReadParquetData).toHaveBeenCalledTimes(2));

    // The file changed under the tab: the count for the kept filter is
    // refused, and so would the one the rollback would ask for.
    mockCountParquetData.mockRejectedValue('boom: No field named id');
    await userEvent.click(screen.getByText('viewer.refresh'));

    await waitFor(() => expect(mockReadParquetData).toHaveBeenCalledTimes(3));
    expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '', null);
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
    expect(screen.queryByText('viewer.error')).not.toBeInTheDocument();
    expect(screen.getByText('viewer.filterDropped')).toBeInTheDocument();
    expect(screen.getByText('"id" = 5')).toBeInTheDocument();
  });

  it('is still a file-level error when the plain first page fails', async () => {
    mockReadParquetData.mockRejectedValueOnce('boom: corrupt page');
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} />);

    expect(await screen.findByText('viewer.error')).toBeInTheDocument();
    expect(screen.getByText('boom: corrupt page')).toBeInTheDocument();
    expect(screen.queryByText('common.apply')).not.toBeInTheDocument();
  });

  it('is a file-level error when the page read after a dropped filter fails too', async () => {
    mockCountParquetData.mockRejectedValueOnce('boom: No field named gone');
    mockReadParquetData.mockRejectedValueOnce('boom: corrupt page');
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} initialState={{ activeFilter: '"gone" = 1' }} />);

    expect(await screen.findByText('viewer.error')).toBeInTheDocument();
    expect(screen.getByText('boom: corrupt page')).toBeInTheDocument();
  });

  it('still reloads the file on Refresh when the cache could not be evicted', async () => {
    await renderViewer();
    mockEvictCache.mockRejectedValueOnce('boom: evict');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await userEvent.click(screen.getByText('viewer.refresh'));

    await waitFor(() => expect(mockOpenParquetFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockReadParquetData).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument();
    expect(screen.queryByText('viewer.error')).not.toBeInTheDocument();
  });
});

describe('DataViewer search commands', () => {
  it('opens the search bar on the find command, only while it is the view on screen', async () => {
    const isActiveRef = { current: false };
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} isActiveRef={isActiveRef} />);
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
    expect(screen.queryByPlaceholderText('viewer.searchPlaceholder')).not.toBeInTheDocument();

    act(() => dispatchAppCommand('find'));
    expect(screen.queryByPlaceholderText('viewer.searchPlaceholder')).not.toBeInTheDocument();

    isActiveRef.current = true;
    act(() => dispatchAppCommand('find'));
    expect(screen.getByPlaceholderText('viewer.searchPlaceholder')).toHaveFocus();
  });
});

describe('DataViewer column profile', () => {
  beforeEach(() => {
    mockProfileCounts.mockResolvedValue({
      column: 'id', kind: 'integer', total_rows: 100, null_count: 0, distinct_count: 2, distinct_approximate: false,
    });
    mockProfileChart.mockResolvedValue({
      shape: 'top_values', values: [{ value: 7, count: 60 }, { value: 9, count: 40 }], other: 0,
    });
  });

  const openButton = () => screen.getByRole('button', { name: 'viewer.profile.open' });
  const panel = () => screen.queryByRole('complementary', { name: 'viewer.profile.title' });

  it("opens the column's panel from its header button, and closes it on the second click", async () => {
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
    expect(panel()).not.toBeInTheDocument();

    await userEvent.click(openButton());
    expect(panel()).toBeInTheDocument();
    expect(openButton()).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(mockProfileCounts).toHaveBeenCalledWith('/data/test.parquet', 'id', undefined, expect.any(String)));

    await userEvent.click(openButton());
    expect(panel()).not.toBeInTheDocument();
  });

  it('adds the clicked value to the filter bar, focused and lit, closes the panel and reloads the grid', async () => {
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
    await userEvent.click(openButton());

    await userEvent.click(await screen.findByRole('button', { name: '7: 60' }));

    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '"id" = 7', null));
    const value = screen.getByPlaceholderText('viewer.filterValuePlaceholder');
    expect(value).toHaveValue('7');
    expect(value).toHaveFocus();
    expect(value).toHaveClass('filter-arrived');
    // One value leaves nothing to chart: the panel is gone and was not
    // asked for a profile under the new filter.
    expect(panel()).not.toBeInTheDocument();
    expect(openButton()).toHaveAttribute('aria-pressed', 'false');
    expect(mockProfileCounts).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel open on a bucket and re-profiles the range under the filter', async () => {
    mockProfileCounts.mockResolvedValue({
      column: 'id', kind: 'integer', total_rows: 100, null_count: 0, distinct_count: 90, distinct_approximate: false,
    });
    mockProfileChart.mockResolvedValue({
      shape: 'histogram', buckets: [{ lower: '0', upper: '50', upper_inclusive: false, count: 60 }], other: 40,
    });
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
    await userEvent.click(openButton());

    await userEvent.click(await screen.findByRole('button', { name: '0 – 50: 60' }));

    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '"id" >= 0 AND "id" < 50', null));
    await waitFor(() => expect(mockProfileCounts).toHaveBeenLastCalledWith('/data/test.parquet', 'id', '"id" >= 0 AND "id" < 50', expect.any(String)));
    // The panel stayed mounted across the grid's reload, for the drill-down.
    expect(panel()).toBeInTheDocument();
    const values = screen.getAllByPlaceholderText('viewer.filterValuePlaceholder');
    expect(values.map(v => (v as HTMLInputElement).value)).toEqual(['0', '50']);
    expect(values[0]).toHaveFocus();
  });
});

describe('DataViewer sort', () => {
  const sortButton = () => screen.getByTitle('viewer.sort.toggle');
  const header = () => screen.getByTitle('id');

  it('sorts ascending, then descending, then back to file order, from the first page each time', async () => {
    await renderViewer();
    const user = userEvent.setup();
    // Start on page 2 so the reset is visible.
    await user.click(screen.getByText('viewer.pagination.next'));
    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 50, 50, '', null));

    await user.click(sortButton());
    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '', { column: 'id', direction: 'asc' }));
    await waitFor(() => expect(header()).toHaveAttribute('aria-sort', 'ascending'));
    expect(pageInput().value).toBe('1');

    await user.click(sortButton());
    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '', { column: 'id', direction: 'desc' }));
    await waitFor(() => expect(header()).toHaveAttribute('aria-sort', 'descending'));

    await user.click(sortButton());
    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '', null));
    await waitFor(() => expect(header()).not.toHaveAttribute('aria-sort'));
  });

  it('rolls the sort back when the sorted load fails, without an echo reload', async () => {
    await renderViewer();
    mockReadParquetData.mockRejectedValueOnce('boom: cannot sort');

    await userEvent.setup().click(sortButton());

    expect(await screen.findByText('viewer.dataError')).toBeInTheDocument();
    expect(screen.getByText('boom: cannot sort')).toBeInTheDocument();
    expect(header()).not.toHaveAttribute('aria-sort');
    // The first load and the failed one; the rollback did not read again.
    expect(mockReadParquetData).toHaveBeenCalledTimes(2);
  });

  it('drops a restored sort by a column the file no longer has', async () => {
    await renderViewer({ sort: { column: 'gone', direction: 'asc' } });
    expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '', null);
    expect(header()).not.toHaveAttribute('aria-sort');
  });

  it('restores a sort by a column the file has', async () => {
    await renderViewer({ sort: { column: 'id', direction: 'desc' } });
    expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '', { column: 'id', direction: 'desc' });
    expect(header()).toHaveAttribute('aria-sort', 'descending');
  });
});
