import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import { useTauriEvent } from '../useTauriEvent';

vi.mock('../../lib/tauri', () => ({ isTauri: () => true }));

describe('useTauriEvent', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('subscribes once, reports itself ready, and unsubscribes on unmount', async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);

    const { result, rerender, unmount } = renderHook(({ handler }) => useTauriEvent('menu', handler), {
      initialProps: { handler: vi.fn() },
    });

    await waitFor(() => expect(result.current).toBe(true));
    rerender({ handler: vi.fn() });
    expect(listen).toHaveBeenCalledTimes(1);

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it('delivers the payload to the latest handler without re-subscribing', async () => {
    vi.mocked(listen).mockResolvedValue(vi.fn());
    const first = vi.fn();
    const latest = vi.fn();

    const { rerender } = renderHook(({ handler }) => useTauriEvent<string>('menu', handler), {
      initialProps: { handler: first },
    });
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    rerender({ handler: latest });

    const deliver = vi.mocked(listen).mock.calls[0][1];
    deliver({ payload: 'find' } as Parameters<typeof deliver>[0]);

    expect(latest).toHaveBeenCalledWith('find');
    expect(first).not.toHaveBeenCalled();
  });

  it('logs a subscription that fails rather than leaving the rejection unhandled', async () => {
    const failure = new Error('no event loop');
    vi.mocked(listen).mockRejectedValue(failure);

    const { result, unmount } = renderHook(() => useTauriEvent('menu', vi.fn()));

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith('Failed to listen for menu:', failure));
    expect(result.current).toBe(false);
    unmount();
  });
});
