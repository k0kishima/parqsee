import { describe, it, expect } from 'vitest';
import { screenFor, isUsable, trialDaysLeft, msUntilTrialEnds, productOfKind } from '../license';
import type { IapStatus, IapProduct } from '../../api';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const status = (partial: Partial<IapStatus>): IapStatus => ({
    state: 'none',
    trial_ends_at: null,
    trial_days: 14,
    store_error: null,
    ...partial,
});

describe('screenFor', () => {
    it('maps each backend state to a screen', () => {
        expect(screenFor(null)).toBe('loading');
        expect(screenFor(status({ state: 'none' }))).toBe('pretrial');
        expect(screenFor(status({ state: 'trial', trial_ends_at: NOW + DAY }))).toBe('app');
        expect(screenFor(status({ state: 'trial_expired', trial_ends_at: NOW - DAY }))).toBe('paywall');
        expect(screenFor(status({ state: 'unlocked' }))).toBe('app');
    });

    it('a store that could not be read is the pre-trial screen with a reason', () => {
        const s = status({ state: 'none', store_error: 'no network' });
        expect(screenFor(s)).toBe('pretrial');
        expect(isUsable(s)).toBe(false);
    });

    it('isUsable is exactly the app screen', () => {
        expect(isUsable(null)).toBe(false);
        expect(isUsable(status({ state: 'trial', trial_ends_at: NOW + DAY }))).toBe(true);
        expect(isUsable(status({ state: 'unlocked' }))).toBe(true);
        expect(isUsable(status({ state: 'trial_expired' }))).toBe(false);
    });
});

describe('trialDaysLeft', () => {
    it('rounds a partial day up and never goes below zero', () => {
        expect(trialDaysLeft(status({ state: 'trial', trial_ends_at: NOW + 14 * DAY }), NOW)).toBe(14);
        expect(trialDaysLeft(status({ state: 'trial', trial_ends_at: NOW + 13 * DAY + 1 }), NOW)).toBe(14);
        expect(trialDaysLeft(status({ state: 'trial', trial_ends_at: NOW + 1 }), NOW)).toBe(1);
        expect(trialDaysLeft(status({ state: 'trial_expired', trial_ends_at: NOW - DAY }), NOW)).toBe(0);
        expect(trialDaysLeft(status({ state: 'none' }), NOW)).toBe(0);
        expect(trialDaysLeft(null, NOW)).toBe(0);
    });
});

describe('msUntilTrialEnds', () => {
    it('is the time to the end of a running trial, capped for setTimeout', () => {
        expect(msUntilTrialEnds(status({ state: 'trial', trial_ends_at: NOW + 5000 }), NOW)).toBe(5000);
        expect(msUntilTrialEnds(status({ state: 'trial', trial_ends_at: NOW + 40 * DAY }), NOW)).toBe(0x7fffffff);
        expect(msUntilTrialEnds(status({ state: 'trial', trial_ends_at: NOW - 1 }), NOW)).toBe(0);
        expect(msUntilTrialEnds(status({ state: 'unlocked', trial_ends_at: NOW + DAY }), NOW)).toBeNull();
        expect(msUntilTrialEnds(status({ state: 'none' }), NOW)).toBeNull();
        expect(msUntilTrialEnds(null, NOW)).toBeNull();
    });
});

describe('productOfKind', () => {
    const products: IapProduct[] = [
        { id: 'parqsee.trial14', kind: 'trial', display_name: '14-day Trial', description: '', display_price: '¥0' },
        { id: 'parqsee.full', kind: 'full', display_name: 'Parqsee Full Version', description: '', display_price: '¥1,500' },
    ];
    it('finds by kind, never by id', () => {
        expect(productOfKind(products, 'full')?.display_price).toBe('¥1,500');
        expect(productOfKind(products, 'trial')?.id).toBe('parqsee.trial14');
        expect(productOfKind([], 'full')).toBeUndefined();
        expect(productOfKind(null, 'full')).toBeUndefined();
    });
});
