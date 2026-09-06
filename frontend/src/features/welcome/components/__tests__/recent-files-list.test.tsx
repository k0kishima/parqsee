import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecentFilesList } from '../recent-files-list';

const mockClear = vi.fn();
const mockRemove = vi.fn();
let files: { path: string; name: string; size: number; last_accessed: string; available: boolean }[] = [];
vi.mock('../../../../contexts/RecentFilesContext', () => ({
  useRecentFiles: () => ({ recentFiles: files, removeRecentFile: mockRemove, clearRecentFiles: mockClear }),
}));

const file = (name: string) => ({ path: `/data/${name}`, name, size: 10, last_accessed: '2026-09-06T00:00:00Z', available: true });

describe('RecentFilesList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files = [file('a.parquet'), file('b.parquet')];
  });

  it('clears the whole list from its heading, with no confirmation', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm');
    render(<RecentFilesList onFileSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'welcome.recentFiles.clear' }));

    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('shows the first five and folds the rest behind Show all', async () => {
    const user = userEvent.setup();
    files = Array.from({ length: 8 }, (_, i) => file(`f${i}.parquet`));
    render(<RecentFilesList onFileSelect={vi.fn()} />);

    const listed = () => screen.getAllByText(/^f\d\.parquet$/).map(el => el.textContent);
    expect(listed()).toEqual(['f0.parquet', 'f1.parquet', 'f2.parquet', 'f3.parquet', 'f4.parquet']);

    await user.click(screen.getByRole('button', { name: 'welcome.recentFiles.showAll' }));
    expect(listed()).toHaveLength(8);

    await user.click(screen.getByRole('button', { name: 'welcome.recentFiles.showLess' }));
    expect(listed()).toHaveLength(5);
  });

  it('has nothing to fold with five or fewer', () => {
    files = Array.from({ length: 5 }, (_, i) => file(`f${i}.parquet`));
    render(<RecentFilesList onFileSelect={vi.fn()} />);
    expect(screen.getAllByText(/^f\d\.parquet$/)).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'welcome.recentFiles.showAll' })).not.toBeInTheDocument();
  });

  it('offers nothing to clear when the list is empty', () => {
    files = [];
    render(<RecentFilesList onFileSelect={vi.fn()} />);
    expect(screen.getByText('welcome.recentFiles.empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'welcome.recentFiles.clear' })).not.toBeInTheDocument();
  });
});
