import type { IapStatus, IapProduct, IapProductKind } from '../api';

/** Which screen the license state calls for. */
export type LicenseScreen = 'loading' | 'pretrial' | 'paywall' | 'app';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `loading` until the backend has answered; `pretrial` when nothing was
 * started (or the store could not be read — the screen shows why);
 * `paywall` once the trial is over; `app` while rows may be read.
 */
export function screenFor(status: IapStatus | null): LicenseScreen {
    if (!status) return 'loading';
    switch (status.state) {
        case 'trial':
        case 'unlocked':
            return 'app';
        case 'trial_expired':
            return 'paywall';
        case 'none':
            return 'pretrial';
    }
}

/** True while the backend lets rows through (see `require_unlocked` in Rust). */
export function isUsable(status: IapStatus | null): boolean {
    return screenFor(status) === 'app';
}

/**
 * Whole days left in the trial, rounded up so the last partial day still
 * reads as one; 0 once it is over or when no trial exists.
 */
export function trialDaysLeft(status: IapStatus | null, now: number): number {
    if (!status || status.trial_ends_at === null) return 0;
    return Math.max(0, Math.ceil((status.trial_ends_at - now) / DAY_MS));
}

/**
 * How long to wait before asking the backend again, so a running app
 * crosses into the paywall at the right moment. `null` when there is
 * nothing to wait for. Capped at what `setTimeout` accepts.
 */
export function msUntilTrialEnds(status: IapStatus | null, now: number): number | null {
    if (!status || status.state !== 'trial' || status.trial_ends_at === null) return null;
    return Math.min(Math.max(status.trial_ends_at - now, 0), 0x7fffffff);
}

export function productOfKind(products: readonly IapProduct[] | null, kind: IapProductKind): IapProduct | undefined {
    return products?.find(p => p.kind === kind);
}
