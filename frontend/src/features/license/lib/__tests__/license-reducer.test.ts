import { describe, it, expect } from 'vitest';
import { reduceLicense, INITIAL_LICENSE, type LicenseModel, type LicenseEvent } from '../license-reducer';
import { screenFor } from '../license';
import type { IapStatus } from '../../api';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const status = (partial: Partial<IapStatus>): IapStatus => ({
    state: 'none',
    trial_ends_at: null,
    trial_days: 14,
    store_error: null,
    ...partial,
});
const NONE = status({ state: 'none' });
const TRIAL = status({ state: 'trial', trial_ends_at: T0 + 14 * DAY });
const EXPIRED = status({ state: 'trial_expired', trial_ends_at: T0 + 14 * DAY });
const UNLOCKED = status({ state: 'unlocked', trial_ends_at: T0 + 14 * DAY });

const run = (events: LicenseEvent[], from: LicenseModel = INITIAL_LICENSE) => events.reduce(reduceLicense, from);

describe('reduceLicense', () => {
    it('none → trial → trial_expired → unlocked, as the backend reports it', () => {
        let m = run([{ type: 'status', status: NONE }]);
        expect(screenFor(m.status)).toBe('pretrial');

        m = run([{ type: 'action-start', action: 'trial' }], m);
        expect(m.busy).toBe('trial');
        m = run([{ type: 'action-done', action: 'trial', status: TRIAL, outcome: 'purchased' }], m);
        expect([m.busy, m.error, screenFor(m.status)]).toEqual([null, null, 'app']);

        // The clock ran out: the timer re-asked the backend.
        m = run([{ type: 'status', status: EXPIRED }], m);
        expect(screenFor(m.status)).toBe('paywall');

        m = run([
            { type: 'action-start', action: 'buy' },
            { type: 'action-done', action: 'buy', status: UNLOCKED, outcome: 'purchased' },
        ], m);
        expect([m.busy, screenFor(m.status)]).toEqual([null, 'app']);
    });

    it('none → unlocked by buying straight away', () => {
        const m = run([
            { type: 'status', status: NONE },
            { type: 'action-start', action: 'buy' },
            { type: 'action-done', action: 'buy', status: UNLOCKED, outcome: 'purchased' },
        ]);
        expect(screenFor(m.status)).toBe('app');
    });

    it('restore takes the status the backend hands back', () => {
        const m = run([
            { type: 'status', status: EXPIRED },
            { type: 'action-start', action: 'restore' },
            { type: 'action-done', action: 'restore', status: UNLOCKED },
        ]);
        expect(screenFor(m.status)).toBe('app');
    });

    it('a cancelled purchase leaves the screen where it was', () => {
        const m = run([
            { type: 'status', status: NONE },
            { type: 'action-start', action: 'buy' },
            { type: 'action-done', action: 'buy', status: NONE, outcome: 'cancelled' },
        ]);
        expect([m.busy, m.error, m.pending, screenFor(m.status)]).toEqual([null, null, false, 'pretrial']);
    });

    it('a failed action keeps the error until the next one starts', () => {
        let m = run([
            { type: 'status', status: EXPIRED },
            { type: 'action-start', action: 'restore' },
            { type: 'action-failed', action: 'restore', error: 'not signed in' },
        ]);
        expect([m.busy, m.error, screenFor(m.status)]).toEqual([null, 'not signed in', 'paywall']);
        m = run([{ type: 'action-start', action: 'buy' }], m);
        expect([m.busy, m.error]).toEqual(['buy', null]);
    });

    it('a pending purchase is remembered until a status settles it', () => {
        let m = run([
            { type: 'status', status: NONE },
            { type: 'action-start', action: 'buy' },
            { type: 'action-done', action: 'buy', status: NONE, outcome: 'pending' },
        ]);
        expect([m.pending, screenFor(m.status)]).toEqual([true, 'pretrial']);
        // A refresh that changes nothing keeps it.
        m = run([{ type: 'status', status: NONE }], m);
        expect(m.pending).toBe(true);
        // The approval arrives as a transaction update.
        m = run([{ type: 'status', status: UNLOCKED }], m);
        expect([m.pending, screenFor(m.status)]).toEqual([false, 'app']);
    });

    it('products load independently of the status', () => {
        let m = run([{ type: 'products-failed', error: 'offline' }]);
        expect([m.products, m.productsError]).toEqual([null, 'offline']);
        const products = [{ id: 'parqsee.full', kind: 'full' as const, display_name: 'Full', description: '', display_price: '¥1,500' }];
        m = run([{ type: 'products', products }], m);
        expect([m.products, m.productsError]).toEqual([products, null]);
    });
});
