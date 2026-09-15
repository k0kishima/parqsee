import { describe, it, expect, vi, beforeEach } from 'vitest';
import { confirm as nativeConfirm } from '@tauri-apps/plugin-dialog';
import { isTauri } from '../tauri';
import { confirmDestructive } from '../dialog';

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn() }));
vi.mock('../tauri', () => ({ isTauri: vi.fn() }));

describe('confirmDestructive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the dialog plugin under Tauri and tells Cancel from OK', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    // Cancel is the case that matters: the plugin replaces `window.confirm`
    // with an async function, so `confirm(...)` hands back a Promise that
    // reads as truthy whichever button was pressed. Awaiting the plugin
    // itself is what keeps Cancel a no.
    vi.mocked(nativeConfirm).mockResolvedValue(false);

    await expect(confirmDestructive('Delete everything?')).resolves.toBe(false);
    expect(nativeConfirm).toHaveBeenCalledWith('Delete everything?', { kind: 'warning' });

    vi.mocked(nativeConfirm).mockResolvedValue(true);
    await expect(confirmDestructive('Delete everything?')).resolves.toBe(true);
  });

  it('falls back to the synchronous window.confirm outside Tauri', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const browserConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await expect(confirmDestructive('Clear all?')).resolves.toBe(true);
    expect(browserConfirm).toHaveBeenCalledWith('Clear all?');
    expect(nativeConfirm).not.toHaveBeenCalled();

    browserConfirm.mockRestore();
  });
});
