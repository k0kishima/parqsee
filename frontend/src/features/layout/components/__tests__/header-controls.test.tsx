import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeaderActions } from '../header-controls';
import { LicenseProvider } from '../../../../contexts/LicenseContext';

let files = [{ path: '/data/a.parquet', name: 'a.parquet', size: 1, last_accessed: 0, available: true }];
vi.mock('../../../../contexts/RecentFilesContext', () => ({
  useRecentFiles: () => ({ recentFiles: files, removeRecentFile: vi.fn(), clearRecentFiles: vi.fn() }),
}));

const handlers = {
  onOpenFile: vi.fn(),
  onOpenFolder: vi.fn(),
  onOpenRecentFile: vi.fn(),
  onOpenSettings: vi.fn(),
};

// The row carries the Free badge, which reads the license.
const renderActions = () =>
  render(
    <LicenseProvider>
      <HeaderActions {...handlers} />
    </LicenseProvider>
  );

describe('HeaderActions › Recent Files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops the panel from its button and takes it back on a second click', async () => {
    const user = userEvent.setup();
    renderActions();
    const button = screen.getByRole('button', { name: 'common.recentFiles' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(button);
    expect(screen.getByRole('dialog', { name: 'common.recentFiles' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(button);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the file picked in the panel and closes it', async () => {
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole('button', { name: 'common.recentFiles' }));
    await user.click(screen.getByRole('button', { name: /a\.parquet/ }));

    expect(handlers.onOpenRecentFile).toHaveBeenCalledWith('/data/a.parquet');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the panel when Open File is clicked instead', async () => {
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole('button', { name: 'common.recentFiles' }));
    await user.click(screen.getByRole('button', { name: /common\.openFile/ }));

    expect(handlers.onOpenFile).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
