import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { dispatchAppCommand } from '../../../../lib/app-commands';
import userEvent from '@testing-library/user-event';
import { DataViewer } from '../data-viewer';

const mockOpenParquetFile = vi.fn();
const mockReadParquetData = vi.fn();
const mockCountParquetData = vi.fn();
const mockEvictCache = vi.fn();
const mockProfileColumn = vi.fn();
vi.mock('../../api', () => ({
  openParquetFile: (...args: unknown[]) => mockOpenParquetFile(...args),
  readParquetData: (...args: unknown[]) => mockReadParquetData(...args),
  countParquetData: (...args: unknown[]) => mockCountParquetData(...args),
  profileColumn: (...args: unknown[]) => mockProfileColumn(...args),
  // The real wrapper swallows the rejection; the double must too, or the
  // "could not be evicted" case below would test an impossible state.
  // api/__tests__/evict-cache-quietly.test.ts pins the real one.
  evictCacheQuietly: (...args: unknown[]) =>
    mockEvictCache(...args).catch((err: unknown) => console.error('Failed to evict cache:', err)),
}));

vi.mock('../../../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: { rowsPerPage: 50, typeDisplay: 'logical', rowDensity: 'comfortable' },
    updateSettings: vi.fn(),
  }),
}));

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
  await user.clear(screen.getByPlaceholderText('viewer.filterValuePlaceholder'));
  await user.type(screen.getByPlaceholderText('viewer.filterValuePlaceholder'), value);
  await user.click(screen.getByText('common.apply'));
};

describe('DataViewer failed-load rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenParquetFile.mockResolvedValue(metadata);
    mockReadParquetData.mockResolvedValue([{ id: 1 }]);
    mockCountParquetData.mockResolvedValue(5);
    mockEvictCache.mockResolvedValue(undefined);
  });

  const renderViewer = async () => {
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} />);
    await waitFor(() => expect(mockReadParquetData).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
  };

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

    expect(await screen.findByText('viewer.dataError')).toBeInTheDocument();
    await waitFor(() => expect(pageInput().value).toBe('1'));
    // offset 0 (initial) + offset 50 (failed) — no echo reload of page 1.
    expect(mockReadParquetData).toHaveBeenCalledTimes(2);
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenParquetFile.mockResolvedValue(metadata);
    mockReadParquetData.mockResolvedValue([{ id: 1 }]);
    mockEvictCache.mockResolvedValue(undefined);
  });

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
    vi.clearAllMocks();
    mockOpenParquetFile.mockResolvedValue(metadata);
    mockReadParquetData.mockResolvedValue([{ id: 1 }]);
    mockCountParquetData.mockResolvedValue(5);
    mockEvictCache.mockResolvedValue(undefined);
    mockProfileColumn.mockResolvedValue({
      column: 'id', kind: 'integer', total_rows: 100, null_count: 0, distinct_count: 2,
      chart: { shape: 'top_values', values: [{ value: 7, count: 60 }, { value: 9, count: 40 }], other: 0 },
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
    await waitFor(() => expect(mockProfileColumn).toHaveBeenCalledWith('/data/test.parquet', 'id', undefined));

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
    expect(mockProfileColumn).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel open on a bucket and re-profiles the range under the filter', async () => {
    mockProfileColumn.mockResolvedValue({
      column: 'id', kind: 'integer', total_rows: 100, null_count: 0, distinct_count: 90,
      chart: { shape: 'histogram', buckets: [{ lower: '0', upper: '50', upper_inclusive: false, count: 60 }], other: 40 },
    });
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
    await userEvent.click(openButton());

    await userEvent.click(await screen.findByRole('button', { name: '0 – 50: 60' }));

    await waitFor(() => expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '"id" >= 0 AND "id" < 50', null));
    await waitFor(() => expect(mockProfileColumn).toHaveBeenLastCalledWith('/data/test.parquet', 'id', '"id" >= 0 AND "id" < 50'));
    // The panel stayed mounted across the grid's reload, for the drill-down.
    expect(panel()).toBeInTheDocument();
    const values = screen.getAllByPlaceholderText('viewer.filterValuePlaceholder');
    expect(values.map(v => (v as HTMLInputElement).value)).toEqual(['0', '50']);
    expect(values[0]).toHaveFocus();
  });
});

describe('DataViewer sort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenParquetFile.mockResolvedValue(metadata);
    mockReadParquetData.mockResolvedValue([{ id: 1 }]);
    mockCountParquetData.mockResolvedValue(5);
    mockEvictCache.mockResolvedValue(undefined);
  });

  const renderViewer = async (initialState?: Parameters<typeof DataViewer>[0]['initialState']) => {
    render(<DataViewer filePath="/data/test.parquet" onClose={vi.fn()} initialState={initialState} />);
    await waitFor(() => expect(mockReadParquetData).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('viewer.loading')).not.toBeInTheDocument());
  };
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
