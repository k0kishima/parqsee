import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LicenseProvider, useLicense } from '../LicenseContext';
import {
    getIapStatus,
    listIapProducts,
    purchaseProduct,
    restorePurchases,
    quitApp,
    onIapStatus,
    type IapStatus,
    type IapProduct,
} from '../../features/license/api';

vi.mock('../../lib/tauri', async () => ({
    ...(await vi.importActual<typeof import('../../lib/tauri')>('../../lib/tauri')),
    isTauri: () => true,
}));
vi.mock('../../features/license/api', () => ({
    getIapStatus: vi.fn(),
    listIapProducts: vi.fn(),
    purchaseProduct: vi.fn(),
    restorePurchases: vi.fn(),
    quitApp: vi.fn(async () => undefined),
    onIapStatus: vi.fn(() => Promise.resolve(() => {})),
}));

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const status = (partial: Partial<IapStatus>): IapStatus => ({
    state: 'none',
    trial_ends_at: null,
    trial_days: 14,
    store_error: null,
    ...partial,
});
const NONE = status({});
const TRIAL = status({ state: 'trial', trial_ends_at: T0 + 14 * DAY });
const EXPIRED = status({ state: 'trial_expired', trial_ends_at: T0 + 14 * DAY });
const UNLOCKED = status({ state: 'unlocked' });
const PRODUCTS: IapProduct[] = [
    { id: 'parqsee.trial14', kind: 'trial', display_name: '14-day Trial', description: '', display_price: '¥0' },
    { id: 'parqsee.full', kind: 'full', display_name: 'Parqsee Full Version', description: '', display_price: '¥1,500' },
];

const wrapper = ({ children }: { children: ReactNode }) => <LicenseProvider>{children}</LicenseProvider>;

/** The backend as a scripted store: what it owns decides every status it reports. */
function backend(initial: IapStatus) {
    let current = initial;
    vi.mocked(getIapStatus).mockImplementation(async () => current);
    vi.mocked(listIapProducts).mockResolvedValue(PRODUCTS);
    vi.mocked(purchaseProduct).mockImplementation(async (id: string) => {
        if (id === 'parqsee.trial14') current = TRIAL;
        if (id === 'parqsee.full') current = UNLOCKED;
        return { outcome: 'purchased', status: current };
    });
    vi.mocked(restorePurchases).mockImplementation(async () => current);
    return {
        set(next: IapStatus) {
            current = next;
        },
    };
}

async function renderLicense() {
    const hook = renderHook(() => useLicense(), { wrapper });
    // The provider renders nothing until the first status has arrived.
    await waitFor(() => expect(hook.result.current).not.toBeNull());
    return hook;
}

describe('LicenseProvider', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true, now: T0 });
        vi.mocked(onIapStatus).mockClear();
        vi.mocked(quitApp).mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('none → trial → trial_expired (by the clock) → unlocked', async () => {
        const store = backend(NONE);
        const { result } = await renderLicense();
        expect(result.current.screen).toBe('pretrial');
        expect(result.current.usable).toBe(false);

        // Start free trial: the trial item is bought.
        await act(() => result.current.startTrial());
        expect(purchaseProduct).toHaveBeenLastCalledWith('parqsee.trial14');
        expect(result.current.screen).toBe('app');
        expect(result.current.usable).toBe(true);
        expect(result.current.daysLeft).toBe(14);
        expect(result.current.busy).toBeNull();

        // The clock runs out while the app is open: the backend is asked
        // again at the moment the trial ends and reports it expired.
        store.set(EXPIRED);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(14 * DAY + 1);
        });
        await waitFor(() => expect(result.current.screen).toBe('paywall'));
        expect(result.current.usable).toBe(false);
        expect(result.current.daysLeft).toBe(0);

        await act(() => result.current.buy());
        expect(purchaseProduct).toHaveBeenLastCalledWith('parqsee.full');
        expect(result.current.screen).toBe('app');
        expect(result.current.status.state).toBe('unlocked');
    });

    it('none → unlocked by buying at once', async () => {
        backend(NONE);
        const { result } = await renderLicense();
        await act(() => result.current.buy());
        expect(result.current.screen).toBe('app');
        expect(result.current.error).toBeNull();
    });

    it('restore on the paywall takes what the account owns', async () => {
        const store = backend(EXPIRED);
        const { result } = await renderLicense();
        expect(result.current.screen).toBe('paywall');
        store.set(UNLOCKED);
        await act(() => result.current.restore());
        expect(restorePurchases).toHaveBeenCalled();
        expect(result.current.screen).toBe('app');
    });

    it('a cancelled purchase and a failed one leave the screen, the failure with its reason', async () => {
        backend(NONE);
        vi.mocked(purchaseProduct).mockResolvedValueOnce({ outcome: 'cancelled', status: NONE });
        const { result } = await renderLicense();
        await act(() => result.current.buy());
        expect([result.current.screen, result.current.error]).toEqual(['pretrial', null]);

        vi.mocked(purchaseProduct).mockRejectedValueOnce('network error');
        await act(() => result.current.buy());
        expect([result.current.screen, result.current.error]).toEqual(['pretrial', 'network error']);

        // The next attempt clears the error.
        await act(() => result.current.buy());
        expect([result.current.screen, result.current.error]).toEqual(['app', null]);
    });

    it('a purchase approved elsewhere arrives through the iap-status event', async () => {
        backend(NONE);
        let push: ((s: IapStatus) => void) | null = null;
        vi.mocked(onIapStatus).mockImplementation(handler => {
            push = handler;
            return Promise.resolve(() => {});
        });
        const { result } = await renderLicense();
        vi.mocked(purchaseProduct).mockResolvedValueOnce({ outcome: 'pending', status: NONE });
        await act(() => result.current.buy());
        expect([result.current.screen, result.current.pending]).toEqual(['pretrial', true]);

        act(() => push!(UNLOCKED));
        expect([result.current.screen, result.current.pending]).toEqual(['app', false]);
    });

    it('products are loaded on request and looked up by kind', async () => {
        backend(NONE);
        const { result } = await renderLicense();
        expect(result.current.products).toBeNull();
        act(() => result.current.loadProducts());
        await waitFor(() => expect(result.current.products).toEqual(PRODUCTS));
        expect(result.current.product('full')?.display_price).toBe('¥1,500');

        vi.mocked(listIapProducts).mockRejectedValueOnce('offline');
        act(() => result.current.loadProducts());
        await waitFor(() => expect(result.current.productsError).toBe('offline'));
    });

    it('a store that cannot be reached locks the app with the reason', async () => {
        vi.mocked(getIapStatus).mockRejectedValue('Checking the purchase failed unexpectedly: boom');
        const { result } = await renderLicense();
        expect(result.current.screen).toBe('pretrial');
        expect(result.current.status.store_error).toContain('boom');
    });

    it('quit asks the backend to exit', async () => {
        backend(EXPIRED);
        const { result } = await renderLicense();
        act(() => result.current.quit());
        expect(quitApp).toHaveBeenCalled();
    });
});
