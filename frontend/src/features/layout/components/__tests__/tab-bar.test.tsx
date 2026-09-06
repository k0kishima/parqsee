import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TabBar } from '../tab-bar';
import { LicenseProvider } from '../../../../contexts/LicenseContext';
import type { Tab } from '../../../../contexts/WorkspaceContext';

const tabs: Tab[] = [
  { id: 'a', path: '/data/a.parquet', name: 'a.parquet' },
  { id: 'b', path: '/data/b.parquet', name: 'b.parquet' },
  { id: 'c', path: '/data/c.parquet', name: 'c.parquet' },
];

const handlers = {
  onTabSelect: vi.fn(),
  onTabClose: vi.fn(),
  onTabsClose: vi.fn(),
  onToggleSidebar: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenFolder: vi.fn(),
  onOpenSettings: vi.fn(),
};

// The bar's right end carries the Free badge, which reads the license.
const renderBar = (list: Tab[] = tabs) =>
  render(
    <LicenseProvider>
      <TabBar tabs={list} activeTabId={list[0]?.id ?? null} isSidebarOpen {...handlers} />
    </LicenseProvider>
  );

/** Right-click the tab showing `name` and return the open menu. */
const openMenuOn = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByText(name) });
  return screen.getByRole('menu');
};

describe('TabBar context menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens on a right-click without switching to the tab', async () => {
    const user = userEvent.setup();
    renderBar();

    await openMenuOn(user, 'b.parquet');

    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Close Tab',
      'Close Other Tabs',
      'Close Tabs to the Right',
    ]);
    expect(handlers.onTabSelect).not.toHaveBeenCalled();
  });

  it('closes the tab it was opened on', async () => {
    const user = userEvent.setup();
    renderBar();

    await openMenuOn(user, 'b.parquet');
    await user.click(screen.getByRole('menuitem', { name: 'Close Tab' }));

    expect(handlers.onTabClose).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the other tabs in one call', async () => {
    const user = userEvent.setup();
    renderBar();

    await openMenuOn(user, 'b.parquet');
    await user.click(screen.getByRole('menuitem', { name: 'Close Other Tabs' }));

    expect(handlers.onTabsClose).toHaveBeenCalledWith(['a', 'c']);
  });

  it('closes only the tabs to the right', async () => {
    const user = userEvent.setup();
    renderBar();

    await openMenuOn(user, 'a.parquet');
    await user.click(screen.getByRole('menuitem', { name: 'Close Tabs to the Right' }));

    expect(handlers.onTabsClose).toHaveBeenCalledWith(['b', 'c']);
  });

  it('disables Close to the Right on the last tab', async () => {
    const user = userEvent.setup();
    renderBar();

    await openMenuOn(user, 'c.parquet');

    expect(screen.getByRole('menuitem', { name: 'Close Tabs to the Right' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Close Other Tabs' })).toBeEnabled();
  });

  it('disables both bulk entries when only one tab is open', async () => {
    const user = userEvent.setup();
    renderBar([tabs[0]]);

    await openMenuOn(user, 'a.parquet');

    expect(screen.getByRole('menuitem', { name: 'Close Other Tabs' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Close Tabs to the Right' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Close Tab' })).toBeEnabled();
  });

  it('goes away on Escape and on a click outside, closing nothing', async () => {
    const user = userEvent.setup();
    renderBar();

    await openMenuOn(user, 'b.parquet');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await openMenuOn(user, 'b.parquet');
    await user.click(screen.getByText('c.parquet'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(handlers.onTabClose).not.toHaveBeenCalled();
    expect(handlers.onTabsClose).not.toHaveBeenCalled();
  });
});
