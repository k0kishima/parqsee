import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { evictCacheQuietly } from '..';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('evictCacheQuietly', () => {
  beforeEach(() => vi.clearAllMocks());

  it('evicts the cached session for the path', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await evictCacheQuietly('/data/a.parquet');
    expect(invoke).toHaveBeenCalledWith('evict_cache', { path: '/data/a.parquet' });
  });

  it('resolves even when the eviction fails, so the caller carries on', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValue('boom: evict');
    await expect(evictCacheQuietly('/data/a.parquet')).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });
});
