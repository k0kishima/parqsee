import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecentFilesPopover } from '../recent-files-popover';

const mockClear = vi.fn();
const mockRemove = vi.fn();
let files: { path: string; name: string; size: number; last_accessed: number; available: boolean }[] = [];
vi.mock('../../../../contexts/RecentFilesContext', () => ({
  useRecentFiles: () => ({ recentFiles: files, removeRecentFile: mockRemove, clearRecentFiles: mockClear }),
}));

const file = (name: string, available = true) => ({ path: `/data/${name}`, name, size: 2048, last_accessed: 1_757_116_800_000, available });

/** The panel under a wrapper standing in for the header's button + anchor. */
const renderPopover = (onFileSelect = vi.fn(), onClose = vi.fn()) => {
  render(
    <div>
      <button>elsewhere</button>
      <div className="relative">
        <button>trigger</button>
        <RecentFilesPopover onFileSelect={onFileSelect} onClose={onClose} />
      </div>
    </div>
  );
  return { onFileSelect, onClose };
};

describe('RecentFilesPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files = [file('a.parquet'), file('b.parquet')];
  });

  it('lists the recent files, newest first as given', () => {
    renderPopover();

    expect(screen.getByRole('dialog', { name: 'common.recentFiles' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual([
      expect.stringContaining('a.parquet'),
      expect.stringContaining('b.parquet'),
    ]);
    expect(screen.getByText('/data/a.parquet')).toBeInTheDocument();
  });

  it('opens the picked file and closes', async () => {
    const user = userEvent.setup();
    const { onFileSelect, onClose } = renderPopover();

    await user.click(screen.getByRole('button', { name: /b\.parquet/ }));

    expect(onFileSelect).toHaveBeenCalledWith('/data/b.parquet');
    expect(onClose).toHaveBeenCalled();
  });

  it('removes one entry and stays open', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPopover();

    await user.click(screen.getAllByRole('button', { name: 'welcome.recentFiles.remove' })[0]);

    expect(mockRemove).toHaveBeenCalledWith('/data/a.parquet');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('marks a file that is no longer available instead of showing its path', () => {
    files = [file('gone.parquet', false)];
    renderPopover();

    expect(screen.getByText('welcome.recentFiles.unavailable')).toBeInTheDocument();
    expect(screen.queryByText('/data/gone.parquet')).not.toBeInTheDocument();
  });

  it('clears the whole list at once, with no confirmation', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm');
    renderPopover();

    await user.click(screen.getByRole('button', { name: 'welcome.recentFiles.clear' }));

    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('offers nothing to clear when the list is empty', () => {
    files = [];
    renderPopover();

    expect(screen.getByText('welcome.recentFiles.empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'welcome.recentFiles.clear' })).not.toBeInTheDocument();
  });

  it('filters by name or path as the search box is typed in, and says when nothing matches', async () => {
    const user = userEvent.setup();
    files = [file('sales.parquet'), file('invoices.parquet'), { ...file('notes.parquet'), path: '/archive/sales/notes.parquet' }];
    renderPopover();
    const search = screen.getByRole('searchbox', { name: 'welcome.recentFiles.search' });
    expect(search).toHaveFocus();

    await user.type(search, 'SALES');
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual([
      expect.stringContaining('sales.parquet'),
      expect.stringContaining('notes.parquet'),
    ]);

    await user.type(search, 'zzz');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText('welcome.recentFiles.noMatches')).toBeInTheDocument();
  });

  it('opens the first match on Enter', async () => {
    const user = userEvent.setup();
    const { onFileSelect, onClose } = renderPopover();

    await user.type(screen.getByRole('searchbox'), 'b{Enter}');

    expect(onFileSelect).toHaveBeenCalledWith('/data/b.parquet');
    expect(onClose).toHaveBeenCalled();
  });

  it('does nothing on Enter when nothing matches', async () => {
    const user = userEvent.setup();
    const { onFileSelect } = renderPopover();

    await user.type(screen.getByRole('searchbox'), 'zzz{Enter}');

    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('adds the parent folder to entries that share a file name', () => {
    files = [
      { ...file('data.parquet'), path: '/exports/2024q1/data.parquet' },
      { ...file('data.parquet'), path: '/exports/2024q2/data.parquet' },
      file('other.parquet'),
    ];
    renderPopover();

    const names = screen.getAllByRole('listitem').map(li => li.querySelector('span span')!.textContent);
    expect(names).toEqual(['data.parquet · 2024q1', 'data.parquet · 2024q2', 'other.parquet']);
  });

  it('shows no search box while the list is empty', () => {
    files = [];
    renderPopover();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('closes on Escape and on a click outside its anchor, but not on its own button', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPopover();

    await user.click(screen.getByRole('button', { name: 'trigger' }));
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
