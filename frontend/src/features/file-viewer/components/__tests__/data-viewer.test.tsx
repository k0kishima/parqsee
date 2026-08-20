import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataViewer } from '../data-viewer';

const mockOpenParquetFile = vi.fn();
const mockReadParquetData = vi.fn();
const mockCountParquetData = vi.fn();
vi.mock('../../api', () => ({
  openParquetFile: (...args: unknown[]) => mockOpenParquetFile(...args),
  readParquetData: (...args: unknown[]) => mockReadParquetData(...args),
  countParquetData: (...args: unknown[]) => mockCountParquetData(...args),
  evictCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: { rowsPerPage: 50, typeDisplay: 'logical' },
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
    expect(mockReadParquetData).toHaveBeenLastCalledWith('/data/test.parquet', 0, 50, '"id" = 7');
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
});
