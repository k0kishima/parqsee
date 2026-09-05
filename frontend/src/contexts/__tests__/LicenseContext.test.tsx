import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LicenseProvider, useLicense } from '../LicenseContext';
import {
    getIapStatus,
    listIapProducts,
    purchaseProduct,
    restorePurchases,
    onIapStatus,
    type IapStatus,
    type IapProduct,
} from '../../features/license/api';
import { FREE_TAB_LIMIT } from '../../features/license/lib/license';

vi.mock('../../lib/tauri', async () => ({
    ...(await vi.importActual<typeof import('../../lib/tauri')>('../../lib/tauri')),
    isTauri: () => true,
}));
vi.mock('../../features/license/api', () => ({
    getIapStatus: vi.fn(),
    listIapProducts: vi.fn(),
    purchaseProduct: vi.fn(),
    restorePurchases: vi.fn(),
    onIapStatus: vi.fn(() => Promise.resolve(() => {})),
}));

const status = (partial: Partial<IapStatus>): IapStatus => ({ state: 'free', store_error: null, ...partial });
const FREE = status({});
const UNLOCKED = status({ state: 'unlocked' });
const PRODUCTS: IapProduct[] = [
    { id: 'parqsee.full', display_name: 'Parqsee Full Version', description: '', display_price: '¥1,500' },
];

const wrapper = ({ children }: { children: ReactNode }) => <LicenseProvider>{children}</LicenseProvider>;

/** The backend as a scripted store: what it owns decides every status it reports. */
function backend(initial: IapStatus) {
    let current = initial;
    vi.mocked(getIapStatus).mockImplementation(async () => current);
    vi.mocked(listIapProducts).mockResolvedValue(PRODUCTS);
    vi.mocked(purchaseProduct).mockImplementation(async (id: string) => {
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
        vi.mocked(onIapStatus).mockClear();
        vi.mocked(purchaseProduct).mockClear();
    });

    it('free with the tab limit → unlocked without one, by buying', async () => {
        backend(FREE);
        const { result } = await renderLicense();
        expect(result.current.unlocked).toBe(false);
        expect(result.current.tabLimit).toBe(FREE_TAB_LIMIT);

        await act(() => result.current.buy());
        // The products were not loaded yet: fetched first, then the one product is bought.
        expect(purchaseProduct).toHaveBeenLastCalledWith('parqsee.full');
        expect(result.current.unlocked).toBe(true);
        expect(result.current.tabLimit).toBeNull();
        expect(result.current.busy).toBeNull();
        expect(result.current.error).toBeNull();
    });

    it('restore takes what the account owns', async () => {
        const store = backend(FREE);
        const { result } = await renderLicense();
        store.set(UNLOCKED);
        await act(() => result.current.restore());
        expect(restorePurchases).toHaveBeenCalled();
        expect(result.current.unlocked).toBe(true);
    });

    it('a cancelled purchase and a failed one leave the free tier, the failure with its reason', async () => {
        backend(FREE);
        vi.mocked(purchaseProduct).mockResolvedValueOnce({ outcome: 'cancelled', status: FREE });
        const { result } = await renderLicense();
        await act(() => result.current.buy());
        expect([result.current.unlocked, result.current.error]).toEqual([false, null]);

        vi.mocked(purchaseProduct).mockRejectedValueOnce('network error');
        await act(() => result.current.buy());
        expect([result.current.unlocked, result.current.error]).toEqual([false, 'network error']);

        // The next attempt clears the error.
        await act(() => result.current.buy());
        expect([result.current.unlocked, result.current.error]).toEqual([true, null]);
    });

    it('a purchase approved elsewhere arrives through the iap-status event and closes the prompt', async () => {
        backend(FREE);
        let push: ((s: IapStatus) => void) | null = null;
        vi.mocked(onIapStatus).mockImplementation(handler => {
            push = handler;
            return Promise.resolve(() => {});
        });
        const { result } = await renderLicense();
        act(() => result.current.showUpgrade());
        vi.mocked(purchaseProduct).mockResolvedValueOnce({ outcome: 'pending', status: FREE });
        await act(() => result.current.buy());
        expect([result.current.unlocked, result.current.pending, result.current.upgradeOpen]).toEqual([false, true, true]);

        act(() => push!(UNLOCKED));
        expect([result.current.unlocked, result.current.pending, result.current.upgradeOpen]).toEqual([true, false, false]);

        // A refund takes the app back to the free tier.
        act(() => push!(FREE));
        expect(result.current.tabLimit).toBe(FREE_TAB_LIMIT);
    });

    it('the upgrade prompt opens and closes on request', async () => {
        backend(FREE);
        const { result } = await renderLicense();
        expect(result.current.upgradeOpen).toBe(false);
        act(() => result.current.showUpgrade());
        expect(result.current.upgradeOpen).toBe(true);
        act(() => result.current.dismissUpgrade());
        expect(result.current.upgradeOpen).toBe(false);
    });

    it('products are loaded on request and the full version is the one product', async () => {
        backend(FREE);
        const { result } = await renderLicense();
        expect(result.current.products).toBeNull();
        expect(result.current.product).toBeUndefined();
        act(() => result.current.loadProducts());
        await waitFor(() => expect(result.current.products).toEqual(PRODUCTS));
        expect(result.current.product?.display_price).toBe('¥1,500');

        vi.mocked(listIapProducts).mockRejectedValueOnce('offline');
        act(() => result.current.loadProducts());
        await waitFor(() => expect(result.current.productsError).toBe('offline'));
    });

    it('a store that cannot be reached leaves the app on the free tier with the reason', async () => {
        vi.mocked(getIapStatus).mockRejectedValue('Checking the purchase failed unexpectedly: boom');
        const { result } = await renderLicense();
        expect(result.current.unlocked).toBe(false);
        expect(result.current.tabLimit).toBe(FREE_TAB_LIMIT);
        expect(result.current.status.store_error).toContain('boom');
    });
});
