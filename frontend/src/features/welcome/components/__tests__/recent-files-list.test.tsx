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

  it('clears the whole list from its heading, after a confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<RecentFilesList onFileSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'welcome.recentFiles.clear' }));
    expect(mockClear).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'welcome.recentFiles.clear' }));
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to clear when the list is empty', () => {
    files = [];
    render(<RecentFilesList onFileSelect={vi.fn()} />);
    expect(screen.getByText('welcome.recentFiles.empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'welcome.recentFiles.clear' })).not.toBeInTheDocument();
  });
});
