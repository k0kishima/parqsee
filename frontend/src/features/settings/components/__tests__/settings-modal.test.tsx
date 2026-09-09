import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { getVersion } from '@tauri-apps/api/app';
import { SettingsModal } from '../settings-modal';

vi.mock('../../../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: { language: 'en', theme: 'system', restoreTabs: true },
    updateSettings: vi.fn(),
  }),
}));

// Settings › Purchase brings the license context with it and has its own
// tests; the version row is what this file is about.
vi.mock('../../../license', () => ({ PurchaseSettings: () => null }));

const open = () =>
  render(<SettingsModal isOpen onClose={vi.fn()} onShowShortcuts={vi.fn()} />);

describe('SettingsModal', () => {
  it("shows the bundle's version", async () => {
    open();

    expect(await screen.findByText('settings.version')).toBeInTheDocument();
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
  });

  it('leaves the row out where no command answers for it', async () => {
    vi.mocked(getVersion).mockRejectedValueOnce(new Error('not tauri'));
    open();

    // The dialog itself is there; only the version row is missing.
    expect(await screen.findByRole('dialog', { name: 'settings.title' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('settings.version')).not.toBeInTheDocument());
  });
});
