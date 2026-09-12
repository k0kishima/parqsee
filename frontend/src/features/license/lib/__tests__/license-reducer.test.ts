import { describe, it, expect } from 'vitest';
import { reduceLicense, INITIAL_LICENSE, type LicenseModel, type LicenseEvent } from '../license-reducer';
import { FREE, UNLOCKED, iapStatus } from './fixtures';

const run = (events: LicenseEvent[], from: LicenseModel = INITIAL_LICENSE) => events.reduce(reduceLicense, from);

describe('reduceLicense', () => {
    it('free → unlocked, as the backend reports it', () => {
        let m = run([{ type: 'status', status: FREE }]);
        expect(m.status?.state).toBe('free');

        m = run([{ type: 'action-start', action: 'buy' }], m);
        expect(m.busy).toBe('buy');
        m = run([{ type: 'action-done', action: 'buy', status: UNLOCKED, outcome: 'purchased' }], m);
        expect([m.busy, m.error, m.status?.state]).toEqual([null, null, 'unlocked']);

        // A refund arrives as a transaction update.
        m = run([{ type: 'status', status: FREE }], m);
        expect(m.status?.state).toBe('free');
    });

    it('restore takes the status the backend hands back', () => {
        const m = run([
            { type: 'status', status: FREE },
            { type: 'action-start', action: 'restore' },
            { type: 'action-done', action: 'restore', status: UNLOCKED },
        ]);
        expect(m.status?.state).toBe('unlocked');
    });

    it('a cancelled purchase leaves everything where it was', () => {
        const m = run([
            { type: 'status', status: FREE },
            { type: 'open-upgrade' },
            { type: 'action-start', action: 'buy' },
            { type: 'action-done', action: 'buy', status: FREE, outcome: 'cancelled' },
        ]);
        expect([m.busy, m.error, m.pending, m.status?.state, m.upgradeOpen]).toEqual([null, null, false, 'free', true]);
    });

    it('a failed action keeps the error until the next one starts', () => {
        let m = run([
            { type: 'status', status: FREE },
            { type: 'action-start', action: 'restore' },
            { type: 'action-failed', action: 'restore', error: 'not signed in' },
        ]);
        expect([m.busy, m.error, m.status?.state]).toEqual([null, 'not signed in', 'free']);
        m = run([{ type: 'action-start', action: 'buy' }], m);
        expect([m.busy, m.error]).toEqual(['buy', null]);
    });

    it('a pending purchase is remembered until an unlocked status settles it', () => {
        let m = run([
            { type: 'status', status: FREE },
            { type: 'action-start', action: 'buy' },
            { type: 'action-done', action: 'buy', status: FREE, outcome: 'pending' },
        ]);
        expect([m.pending, m.status?.state]).toEqual([true, 'free']);
        // A refresh that changes nothing keeps it.
        m = run([{ type: 'status', status: FREE }], m);
        expect(m.pending).toBe(true);
        // The approval arrives as a transaction update.
        m = run([{ type: 'status', status: UNLOCKED }], m);
        expect([m.pending, m.status?.state]).toEqual([false, 'unlocked']);
    });

    it('the upgrade prompt opens and closes on request, and closes on its own once unlocked', () => {
        let m = run([{ type: 'status', status: FREE }, { type: 'open-upgrade' }]);
        expect(m.upgradeOpen).toBe(true);
        m = run([{ type: 'close-upgrade' }], m);
        expect(m.upgradeOpen).toBe(false);

        m = run([
            { type: 'open-upgrade' },
            { type: 'action-start', action: 'buy' },
            { type: 'action-done', action: 'buy', status: UNLOCKED, outcome: 'purchased' },
        ], m);
        expect(m.upgradeOpen).toBe(false);

        // A purchase approved elsewhere closes it too.
        m = run([{ type: 'open-upgrade' }, { type: 'status', status: UNLOCKED }], m);
        expect(m.upgradeOpen).toBe(false);
    });

    it('products load independently of the status', () => {
        let m = run([{ type: 'products-failed', error: 'offline' }]);
        expect([m.products, m.productsError]).toEqual([null, 'offline']);
        const products = [{ id: 'parqsee.full', display_name: 'Full', description: '', display_price: '¥1,500' }];
        m = run([{ type: 'products', products }], m);
        expect([m.products, m.productsError]).toEqual([products, null]);
    });
});

// The backend numbers every change (`revision`); its event and a command's
// answer can cross on the way to the webview, and the older must not win.
describe('reduceLicense on statuses that arrive out of order', () => {
    const free = (revision: number) => iapStatus({ state: 'free', revision });
    const unlocked = (revision: number) => iapStatus({ state: 'unlocked', revision });

    it('drops a status older than the one held, whichever way it arrives', () => {
        // A refund's event got here before the launch-time answer.
        let m = run([{ type: 'status', status: free(2) }, { type: 'status', status: unlocked(1) }]);
        expect(m.status).toEqual(free(2));
        // The same change reported twice (the answer and the event) is fine.
        m = run([{ type: 'status', status: free(2) }], m);
        expect(m.status).toEqual(free(2));
        // A newer one replaces it.
        m = run([{ type: 'status', status: unlocked(3) }], m);
        expect(m.status).toEqual(unlocked(3));
    });

    it('a refund pushed while restore was answering outranks the answer, which still ends the action', () => {
        const m = run([
            { type: 'status', status: free(1) },
            { type: 'open-upgrade' },
            { type: 'action-start', action: 'restore' },
            // The restore read unlocked at 2; a refund (3) was pushed before its answer arrived.
            { type: 'status', status: free(3) },
            { type: 'action-done', action: 'restore', status: unlocked(2) },
        ]);
        expect([m.busy, m.error, m.status, m.upgradeOpen]).toEqual([null, null, free(3), true]);
    });

    it("a purchase's answer outranks an update pushed before its read", () => {
        const m = run([
            { type: 'status', status: free(1) },
            { type: 'open-upgrade' },
            { type: 'action-start', action: 'buy' },
            { type: 'status', status: free(2) },
            { type: 'action-done', action: 'buy', status: unlocked(3), outcome: 'purchased' },
        ]);
        expect([m.busy, m.status, m.upgradeOpen]).toEqual([null, unlocked(3), false]);
    });

    it('a pending outcome is remembered even when its answer is stale', () => {
        const m = run([
            { type: 'status', status: free(2) },
            { type: 'action-start', action: 'buy' },
            { type: 'action-done', action: 'buy', status: free(1), outcome: 'pending' },
        ]);
        expect([m.pending, m.status]).toEqual([true, free(2)]);
    });

    it('the timed-out answer (revision 0) fills in, and never outranks a real one', () => {
        const timedOut = iapStatus({ store_error: 'the App Store did not answer in time', revision: 0 });
        let m = run([{ type: 'status', status: timedOut }]);
        expect(m.status).toEqual(timedOut);
        // The launch-time read lands as an event.
        m = run([{ type: 'status', status: unlocked(1) }], m);
        expect(m.status).toEqual(unlocked(1));
        // A read that fails afterwards (revision 0 again) changes nothing.
        m = run([{ type: 'status', status: timedOut }], m);
        expect(m.status).toEqual(unlocked(1));
    });
});
