import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionSaver, type SessionSaver } from '../session-saver';
import type { SessionSnapshot } from '../workspace-tabs';

const DELAY = 250;

function snapshot(...paths: string[]): SessionSnapshot {
  return {
    tabs: paths.map(path => ({
      path,
      state: { view_mode: null, current_page: null, active_filter: null, sort: null },
    })),
    active: paths[0] ?? null,
  };
}

describe('createSessionSaver', () => {
  let saved: SessionSnapshot[];
  let failed: boolean[];
  let errors: unknown[];
  let resolvers: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  let saver: SessionSaver;

  beforeEach(() => {
    vi.useFakeTimers();
    saved = [];
    failed = [];
    errors = [];
    resolvers = [];
    saver = createSessionSaver({
      delayMs: DELAY,
      onFailed: value => failed.push(value),
      onError: error => errors.push(error),
      save: s => {
        saved.push(s);
        return new Promise<void>((resolve, reject) => resolvers.push({ resolve, reject }));
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the promise callbacks behind a settled write run. */
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };

  const finish = async (index = 0) => {
    resolvers[index].resolve();
    await settle();
  };

  const fail = async (error: unknown, index = 0) => {
    resolvers[index].reject(error);
    await settle();
  };

  it('holds a change back until the tabs have been still for the delay', async () => {
    saver.schedule(snapshot('a'));
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(saved).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([snapshot('a')]);
  });

  it('writes the latest of the changes that arrived during the delay, once', async () => {
    saver.schedule(snapshot('a'));
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    saver.schedule(snapshot('a', 'b'));
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(saved).toEqual([snapshot('a', 'b')]);
  });

  it('flushes what is pending now instead of waiting out the delay', async () => {
    saver.schedule(snapshot('a'));
    saver.flush();
    expect(saved).toEqual([snapshot('a')]);

    await vi.advanceTimersByTimeAsync(DELAY);
    expect(saved).toHaveLength(1); // the timer it cancelled did not fire too
  });

  it('has nothing to flush when nothing changed', () => {
    saver.flush();
    expect(saved).toEqual([]);
  });

  it('runs a flush requested during a write once the write lands, however often it was asked', async () => {
    saver.schedule(snapshot('a'));
    saver.flush();
    expect(saved).toHaveLength(1);

    saver.schedule(snapshot('a', 'b'));
    saver.flush();
    saver.flush();
    saver.flush();
    expect(saved).toHaveLength(1); // serialized: nothing goes out beside the first

    await finish(0);
    expect(saved).toEqual([snapshot('a'), snapshot('a', 'b')]);
  });

  it('drops a pending write for a snapshot already on disk', async () => {
    saver.schedule(snapshot('a'));
    saver.flush();
    await finish(0);

    saver.schedule(snapshot('a', 'b'));
    saver.schedule(snapshot('a'));
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(saved).toHaveLength(1);
  });

  it('reports a failure and leaves the retry to the next change, never to itself', async () => {
    saver.schedule(snapshot('a'));
    saver.flush();
    await fail(new Error('disk full'), 0);

    expect(failed).toEqual([true]);
    expect(errors).toHaveLength(1);

    // Nothing of its own accord, however long it is left alone.
    await vi.advanceTimersByTimeAsync(DELAY * 10);
    expect(saved).toHaveLength(1);

    // The next change writes the same tabs again: the failure did not
    // record them as saved.
    saver.schedule(snapshot('a', 'b'));
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(saved).toEqual([snapshot('a'), snapshot('a', 'b')]);
  });

  it('stays quiet about a failure once a newer change is waiting to be written', async () => {
    saver.schedule(snapshot('a'));
    saver.flush();
    saver.schedule(snapshot('a', 'b'));
    await fail(new Error('disk full'), 0);

    // The failed snapshot is no longer the one to reach, and the write
    // that replaces it reports its own outcome; telling the user a save
    // failed while the next one is already on its way would be noise.
    expect(errors).toHaveLength(1);
    expect(failed).toEqual([]);
  });

  it('keeps a change that arrived mid-write instead of treating it as acknowledged', async () => {
    saver.schedule(snapshot('a'));
    saver.flush();
    saver.schedule(snapshot('a', 'b'));
    await finish(0);

    expect(failed).toEqual([]); // the newer state is not on disk yet

    await vi.advanceTimersByTimeAsync(DELAY);
    expect(saved).toEqual([snapshot('a'), snapshot('a', 'b')]);
  });

  it('settles the failure once a later write lands', async () => {
    saver.schedule(snapshot('a'));
    saver.flush();
    await fail(new Error('disk full'), 0);

    saver.schedule(snapshot('a', 'b'));
    await vi.advanceTimersByTimeAsync(DELAY);
    await finish(1);

    expect(failed).toEqual([true, false]);
  });
});
