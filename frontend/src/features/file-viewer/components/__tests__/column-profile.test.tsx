import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColumnProfilePanel } from '../column-profile';
import type { ColumnCounts, ColumnInfo, ProfileChart } from '../../api';

const mockCounts = vi.fn();
const mockChart = vi.fn();
vi.mock('../../api', () => ({
  profileColumnCounts: (...args: unknown[]) => mockCounts(...args),
  profileColumnChart: (...args: unknown[]) => mockChart(...args),
}));

const mockCancelProfile = vi.fn();
vi.mock('../../../../lib/profile-request', async (original) => ({
  ...(await original<typeof import('../../../../lib/profile-request')>()),
  cancelProfile: (...args: unknown[]) => mockCancelProfile(...args),
}));

const cat: ColumnInfo = { name: 'cat', column_type: 'STRING', kind: 'text', logical_type: 'STRING', physical_type: 'BYTE_ARRAY' };
const price: ColumnInfo = { name: 'price', column_type: 'DOUBLE', kind: 'float', logical_type: null, physical_type: 'DOUBLE' };

/** The two answers a panel asks for, which together are one column's profile. */
interface Profile {
  counts: ColumnCounts;
  chart: ProfileChart;
}

const topValues: Profile = {
  counts: { column: 'cat', kind: 'text', total_rows: 5, null_count: 1, distinct_count: 3, distinct_approximate: false },
  chart: { shape: 'top_values', values: [{ value: 'a', count: 2 }, { value: 'b', count: 1 }, { value: 'c', count: 1 }], other: 0 },
};

const histogram: Profile = {
  counts: { column: 'price', kind: 'float', total_rows: 100, null_count: 0, distinct_count: 90, distinct_approximate: false },
  chart: {
    shape: 'histogram',
    buckets: [{ lower: '0', upper: '0.5', upper_inclusive: false, count: 60 }, { lower: '0.5', upper: '1', upper_inclusive: false, count: 37 }],
    other: 3,
  },
};

/** Answer both calls, as the backend would for one column. */
function answers({ counts, chart }: Profile) {
  mockCounts.mockResolvedValue(counts);
  mockChart.mockResolvedValue(chart);
}

function renderPanel(column: ColumnInfo, filter = '') {
  const onAddConditions = vi.fn();
  const onClose = vi.fn();
  const { rerender, unmount } = render(
    <ColumnProfilePanel filePath="/data/t.parquet" column={column} filter={filter} onClose={onClose} onAddConditions={onAddConditions} />
  );
  const show = (next: ColumnInfo, nextFilter = '') => rerender(
    <ColumnProfilePanel filePath="/data/t.parquet" column={next} filter={nextFilter} onClose={onClose} onAddConditions={onAddConditions} />
  );
  return { onAddConditions, onClose, show, unmount };
}

describe('ColumnProfilePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the counts and every value, and a click filters by the value and closes the panel', async () => {
    answers(topValues);
    const { onAddConditions, onClose } = renderPanel(cat);
    expect(screen.getByText('viewer.profile.loading')).toBeInTheDocument();

    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(mockCounts).toHaveBeenCalledWith('/data/t.parquet', 'cat', undefined, expect.any(String));
    expect(screen.getByText('1 20%')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // A complete list is headed "Values", not "Top n of m".
    expect(await screen.findByText('viewer.profile.values')).toBeInTheDocument();
    const rows = screen.getAllByRole('button').filter(b => b.getAttribute('aria-label')?.includes(':'));
    expect(rows.map(r => r.getAttribute('aria-label'))).toEqual(['a: 2', 'b: 1', 'c: 1', 'viewer.profile.null: 1']);

    await userEvent.click(screen.getByRole('button', { name: 'a: 2' }));
    expect(onAddConditions).toHaveBeenCalledWith([{ column: 'cat', operator: '=', value: 'a' }]);
    // One value leaves nothing to chart, so the panel goes.
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'viewer.profile.null: 1' }));
    expect(onAddConditions).toHaveBeenCalledWith([{ column: 'cat', operator: 'IS NULL', value: '' }]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // The counts are one scan and the chart another; on a large column the
  // chart is the slow one, so what is already known is shown meanwhile.
  it('shows the counts while the chart is still being scanned, and the chart is asked for with them', async () => {
    mockCounts.mockResolvedValue(topValues.counts);
    mockChart.mockImplementation(() => new Promise(() => {}));
    renderPanel(cat);

    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(screen.getByText('1 20%')).toBeInTheDocument();
    expect(screen.getByText('viewer.profile.loading')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'a: 2' })).not.toBeInTheDocument();
    // The chart is chosen from the counts, so it is asked for with them and
    // under the same request id.
    const [, , , countsId] = mockCounts.mock.calls[0];
    expect(mockChart).toHaveBeenCalledWith('/data/t.parquet', 'cat', undefined, topValues.counts, countsId);
  });

  it('keeps the counts when the chart fails and puts the error where the bars would be', async () => {
    mockCounts.mockResolvedValue(topValues.counts);
    mockChart.mockRejectedValue('boom: the chart scan failed');
    renderPanel(cat);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom: the chart scan failed');
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('turns a histogram bucket into a range condition, stays open for the drill-down, and names what was not binned', async () => {
    answers(histogram);
    const { onAddConditions, onClose } = renderPanel(price, '"price" > 0');
    expect(await screen.findByText('viewer.profile.distribution')).toBeInTheDocument();
    expect(mockCounts).toHaveBeenCalledWith('/data/t.parquet', 'price', '"price" > 0', expect.any(String));
    expect(screen.getByText('viewer.profile.notBinned')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '0.5 – 1: 37' }));
    expect(onAddConditions).toHaveBeenCalledWith([
      { column: 'price', operator: '>=', value: '0.5' },
      { column: 'price', operator: '<', value: '1' },
    ]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says when the list is only the commonest values', async () => {
    answers({
      counts: { ...topValues.counts, distinct_count: 40 },
      chart: { ...topValues.chart, other: 30 } as ProfileChart,
    });
    renderPanel(cat);
    expect(await screen.findByText('viewer.profile.topValues')).toBeInTheDocument();
    expect(screen.getByText('viewer.profile.otherValues')).toBeInTheDocument();
  });

  it('includes the last instant of a time bucket in the filter', async () => {
    answers({
      counts: histogram.counts,
      chart: { shape: 'histogram', other: 0, buckets: [{ lower: '23:59:58', upper: '23:59:59.999999', upper_inclusive: true, count: 2 }] },
    });
    const { onAddConditions } = renderPanel({ ...price, kind: 'temporal' });
    await userEvent.click(await screen.findByRole('button', { name: '23:59:58 – ≤ 23:59:59.999999: 2' }));
    expect(onAddConditions).toHaveBeenCalledWith([
      { column: 'price', operator: '>=', value: '23:59:58' },
      { column: 'price', operator: '<=', value: '23:59:59.999999' },
    ]);
  });

  it('labels an empty string visibly while keeping the empty filter value', async () => {
    answers({ counts: topValues.counts, chart: { shape: 'top_values', other: 0, values: [{ value: '', count: 2 }] } });
    const { onAddConditions } = renderPanel(cat);
    await userEvent.click(await screen.findByRole('button', { name: '"": 2' }));
    expect(onAddConditions).toHaveBeenCalledWith([{ column: 'cat', operator: '=', value: '' }]);
  });

  it('keeps the counts for a column with no chart', async () => {
    answers({
      counts: { column: 'li', kind: 'nested', total_rows: 3, null_count: 1, distinct_count: null, distinct_approximate: false },
      chart: { shape: 'unsupported' },
    });
    renderPanel({ ...cat, name: 'li', kind: 'nested' });
    expect(await screen.findByText('viewer.profile.noChart')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('re-profiles when the filter changes and keeps only the newest answer', async () => {
    let resolveFirst: (counts: ColumnCounts) => void = () => {};
    mockCounts.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    mockCounts.mockResolvedValueOnce({ ...topValues.counts, total_rows: 42, null_count: 0 });
    mockChart.mockResolvedValue(topValues.chart);
    const onAddConditions = vi.fn();
    const { rerender } = render(
      <ColumnProfilePanel filePath="/data/t.parquet" column={cat} filter="" onClose={vi.fn()} onAddConditions={onAddConditions} />
    );
    rerender(
      <ColumnProfilePanel filePath="/data/t.parquet" column={cat} filter={'"cat" = \'a\''} onClose={vi.fn()} onAddConditions={onAddConditions} />
    );
    expect(await screen.findByText('42')).toBeInTheDocument();

    // The unfiltered answer arrives late and must not overwrite the filtered one.
    resolveFirst(topValues.counts);
    await waitFor(() => expect(mockCounts).toHaveBeenCalledTimes(2));
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByText('5')).not.toBeInTheDocument();
  });

  it('shows the backend error and closes on its button', async () => {
    mockCounts.mockRejectedValue('boom: no such column');
    const { onClose } = renderPanel(cat);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom: no such column');
    await userEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it.each(['column', 'filter', 'file'] as const)('removes old clickable bars immediately when the %s changes', async change => {
    mockCounts.mockResolvedValueOnce(topValues.counts);
    mockChart.mockResolvedValueOnce(topValues.chart);
    mockCounts.mockImplementationOnce(() => new Promise(() => {}));
    const props = { filePath: '/data/t.parquet', column: cat, filter: '', onClose: vi.fn(), onAddConditions: vi.fn() };
    const { rerender } = render(<ColumnProfilePanel {...props} />);
    expect(await screen.findByRole('button', { name: 'a: 2' })).toBeInTheDocument();
    rerender(<ColumnProfilePanel {...props}
      column={change === 'column' ? price : cat}
      filter={change === 'filter' ? '"id" > 10' : ''}
      filePath={change === 'file' ? '/data/other.parquet' : props.filePath}
    />);
    expect(screen.queryByRole('button', { name: 'a: 2' })).not.toBeInTheDocument();
    expect(screen.getByText('viewer.profile.loading')).toBeInTheDocument();
    expect(props.onAddConditions).not.toHaveBeenCalled();
  });

  // A profile is a scan holding memory the next one needs, so a panel that
  // has moved on says so rather than only dropping the answer.
  it('cancels the request it stops waiting for, by the id it asked with', async () => {
    answers(topValues);
    const { show, unmount } = renderPanel(cat);
    expect(await screen.findByText('5')).toBeInTheDocument();
    const [, , , firstId] = mockCounts.mock.calls[0];

    answers(histogram);
    show(price);
    await waitFor(() => expect(mockCounts).toHaveBeenCalledTimes(2));
    const [, , , secondId] = mockCounts.mock.calls[1];
    expect(secondId).not.toBe(firstId);
    expect(mockCancelProfile).toHaveBeenCalledWith(firstId);
    expect(mockCancelProfile).not.toHaveBeenCalledWith(secondId);

    // Closing the panel is the other way to stop waiting.
    unmount();
    expect(mockCancelProfile).toHaveBeenCalledWith(secondId);
  });

  // A column too wide to count exactly is answered with an estimate, and
  // the panel has to say so: the number would otherwise be read as a count.
  it('marks an estimated distinct count as one and says why there is no exact number', async () => {
    answers({
      counts: { ...topValues.counts, total_rows: 58_000_000, distinct_count: 57_963_093, distinct_approximate: true },
      chart: { ...topValues.chart, other: 57_999_997 } as ProfileChart,
    });
    renderPanel(cat);

    expect(await screen.findByText('≈ 57,963,093')).toBeInTheDocument();
    expect(screen.getByText('viewer.profile.distinctEstimated')).toBeInTheDocument();
    // Not as a plain number beside "Rows" and "NULL".
    expect(screen.queryByText('57,963,093')).not.toBeInTheDocument();
  });
});
