import type { SessionSnapshot } from './workspace-tabs';

/**
 * When the open tabs reach the backend's session store.
 *
 * The rule is not "write on change": a change arrives on every keystroke in
 * the filter bar and on every page, so a write is held back until the tabs
 * have been still for `delayMs`, and the window going away or the provider
 * unmounting flushes whatever is left. Writes are serialized — an older
 * completion must not be the last one to land on disk — so a flush while a
 * write is in flight is remembered and runs after it, once, however many
 * times it was asked for.
 *
 * A failure never starts a retry loop of its own: the next change or the
 * next explicit flush is what tries again. `onFailed` carries that state to
 * the UI, and is answered with `false` as soon as a write lands or the
 * snapshot turns out to be the one already on disk.
 *
 * The scheduling is separated from `save` so that these transitions can be
 * exercised on their own. They are easy to get subtly wrong and hard to see
 * afterwards: a timer that outlived an unmounted provider once leaked a
 * write into the next test, which showed up only as a flake under load.
 */
export interface SessionSaverOptions {
  /** The write itself. Its rejection is a failed save, nothing more. */
  save: (snapshot: SessionSnapshot) => Promise<void>;
  /** How long the tabs must be still before a scheduled write goes out. */
  delayMs: number;
  /** Told whether the last attempt left something unwritten. */
  onFailed: (failed: boolean) => void;
  /** Where a failed write is recorded. Defaults to the console. */
  onError?: (error: unknown) => void;
}

export interface SessionSaver {
  /**
   * Take a snapshot as the state to reach. A snapshot equal to the one
   * already scheduled changes nothing; one equal to what is on disk (while
   * nothing is in flight) cancels the pending write instead of repeating it.
   */
  schedule: (snapshot: SessionSnapshot) => void;
  /** Write what is pending now rather than when the delay elapses. */
  flush: () => void;
}

interface Pending {
  snapshot: SessionSnapshot;
  key: string;
  timer: ReturnType<typeof setTimeout>;
}

export function createSessionSaver({ save, delayMs, onFailed, onError }: SessionSaverOptions): SessionSaver {
  const report = onError ?? ((error: unknown) => console.error('Failed to save the session:', error));
  let pending: Pending | null = null;
  let lastSaved: string | null = null;
  let saving = false;
  let flushRequested = false;

  const flush = (): void => {
    const current = pending;
    if (!current) return;
    clearTimeout(current.timer);
    if (saving) {
      flushRequested = true;
      return;
    }
    if (current.key === lastSaved) {
      pending = null;
      onFailed(false);
      return;
    }
    saving = true;
    flushRequested = false;
    save(current.snapshot)
      .then(() => {
        lastSaved = current.key;
        // A change that arrived while this write was out is a newer state
        // to reach, not this one being acknowledged.
        if (pending === current) {
          pending = null;
          onFailed(false);
        }
      })
      .catch(error => {
        report(error);
        if (pending === current) onFailed(true);
      })
      .finally(() => {
        saving = false;
        if (flushRequested) {
          flushRequested = false;
          flush();
        }
      });
  };

  const schedule = (snapshot: SessionSnapshot): void => {
    const key = JSON.stringify(snapshot);
    if (key === pending?.key) return;
    if (pending) clearTimeout(pending.timer);
    if (!saving && key === lastSaved) {
      pending = null;
      onFailed(false);
      return;
    }
    pending = { snapshot, key, timer: setTimeout(flush, delayMs) };
  };

  return { schedule, flush };
}
