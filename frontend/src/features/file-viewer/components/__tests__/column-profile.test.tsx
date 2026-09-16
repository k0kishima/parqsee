import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColumnProfilePanel } from '../column-profile';
import type { ColumnInfo, ColumnProfile } from '../../api';

const mockProfileColumn = vi.fn();
vi.mock('../../api', () => ({
  profileColumn: (...args: unknown[]) => mockProfileColumn(...args),
}));

const cat: ColumnInfo = { name: 'cat', column_type: 'STRING', kind: 'text', logical_type: 'STRING', physical_type: 'BYTE_ARRAY' };
const price: ColumnInfo = { name: 'price', column_type: 'DOUBLE', kind: 'float', logical_type: null, physical_type: 'DOUBLE' };

const topValues: ColumnProfile = {
  column: 'cat',
  kind: 'text',
  total_rows: 5,
  null_count: 1,
  distinct_count: 3,
  chart: { shape: 'top_values', values: [{ value: 'a', count: 2 }, { value: 'b', count: 1 }, { value: 'c', count: 1 }], other: 0 },
};

const histogram: ColumnProfile = {
  column: 'price',
  kind: 'float',
  total_rows: 100,
  null_count: 0,
  distinct_count: 90,
  chart: {
    shape: 'histogram',
    buckets: [{ lower: '0', upper: '0.5', count: 60 }, { lower: '0.5', upper: '1', count: 37 }],
    other: 3,
  },
};

function renderPanel(column: ColumnInfo, filter = '') {
  const onAddConditions = vi.fn();
  const onClose = vi.fn();
  render(
    <ColumnProfilePanel filePath="/data/t.parquet" column={column} filter={filter} onClose={onClose} onAddConditions={onAddConditions} />
  );
  return { onAddConditions, onClose };
}

describe('ColumnProfilePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the counts and every value, and a click filters by the value', async () => {
    mockProfileColumn.mockResolvedValue(topValues);
    const { onAddConditions } = renderPanel(cat);
    expect(screen.getByText('viewer.profile.loading')).toBeInTheDocument();

    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(mockProfileColumn).toHaveBeenCalledWith('/data/t.parquet', 'cat', undefined);
    expect(screen.getByText('1 20%')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // A complete list is headed "Values", not "Top n of m".
    expect(screen.getByText('viewer.profile.values')).toBeInTheDocument();
    const rows = screen.getAllByRole('button').filter(b => b.getAttribute('aria-label')?.includes(':'));
    expect(rows.map(r => r.getAttribute('aria-label'))).toEqual(['a: 2', 'b: 1', 'c: 1', 'viewer.profile.null: 1']);

    await userEvent.click(screen.getByRole('button', { name: 'a: 2' }));
    expect(onAddConditions).toHaveBeenCalledWith([{ column: 'cat', operator: '=', value: 'a' }]);

    await userEvent.click(screen.getByRole('button', { name: 'viewer.profile.null: 1' }));
    expect(onAddConditions).toHaveBeenCalledWith([{ column: 'cat', operator: 'IS NULL', value: '' }]);
  });

  it('turns a histogram bucket into a range condition and names what was not binned', async () => {
    mockProfileColumn.mockResolvedValue(histogram);
    const { onAddConditions } = renderPanel(price, '"price" > 0');
    expect(await screen.findByText('viewer.profile.distribution')).toBeInTheDocument();
    expect(mockProfileColumn).toHaveBeenCalledWith('/data/t.parquet', 'price', '"price" > 0');
    expect(screen.getByText('viewer.profile.notBinned')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '0.5 – 1: 37' }));
    expect(onAddConditions).toHaveBeenCalledWith([
      { column: 'price', operator: '>=', value: '0.5' },
      { column: 'price', operator: '<', value: '1' },
    ]);
  });

  it('says when the list is only the commonest values', async () => {
    mockProfileColumn.mockResolvedValue({ ...topValues, distinct_count: 40, chart: { ...topValues.chart, other: 30 } });
    renderPanel(cat);
    expect(await screen.findByText('viewer.profile.topValues')).toBeInTheDocument();
    expect(screen.getByText('viewer.profile.otherValues')).toBeInTheDocument();
  });

  it('keeps the counts for a column with no chart', async () => {
    mockProfileColumn.mockResolvedValue({ column: 'li', kind: 'nested', total_rows: 3, null_count: 1, distinct_count: null, chart: { shape: 'unsupported' } });
    renderPanel({ ...cat, name: 'li', kind: 'nested' });
    expect(await screen.findByText('viewer.profile.noChart')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('re-profiles when the filter changes and keeps only the newest answer', async () => {
    let resolveFirst: (p: ColumnProfile) => void = () => {};
    mockProfileColumn.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    mockProfileColumn.mockResolvedValueOnce({ ...topValues, total_rows: 42, null_count: 0 });
    const onAddConditions = vi.fn();
    const { rerender } = render(
      <ColumnProfilePanel filePath="/data/t.parquet" column={cat} filter="" onClose={vi.fn()} onAddConditions={onAddConditions} />
    );
    rerender(
      <ColumnProfilePanel filePath="/data/t.parquet" column={cat} filter={'"cat" = \'a\''} onClose={vi.fn()} onAddConditions={onAddConditions} />
    );
    expect(await screen.findByText('42')).toBeInTheDocument();

    // The unfiltered answer arrives late and must not overwrite the filtered one.
    resolveFirst(topValues);
    await waitFor(() => expect(mockProfileColumn).toHaveBeenCalledTimes(2));
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByText('5')).not.toBeInTheDocument();
  });

  it('shows the backend error and closes on its button', async () => {
    mockProfileColumn.mockRejectedValue('boom: no such column');
    const { onClose } = renderPanel(cat);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom: no such column');
    await userEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
