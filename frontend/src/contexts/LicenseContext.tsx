import { createContext, useContext, useEffect, useReducer, useCallback, useRef, ReactNode } from 'react';
import { isTauri, toErrorMessage } from '../lib/tauri';
import {
    IapStatus,
    IapProduct,
    getIapStatus,
    listIapProducts,
    purchaseProduct,
    restorePurchases,
    onIapStatus,
} from '../features/license/api';
import { tabLimitFor, fullProduct } from '../features/license/lib/license';
import { reduceLicense, INITIAL_LICENSE, LicenseAction } from '../features/license/lib/license-reducer';

export type { IapStatus, IapProduct, LicenseAction };

/** What a build without a store answers, so the browser fallback behaves like one. */
const UNLOCKED: IapStatus = { state: 'unlocked', store_error: null, has_store: false };

interface LicenseContextType {
    status: IapStatus;
    /** `null` until `loadProducts` has run; empty in a build without a store. */
    products: IapProduct[] | null;
    productsError: string | null;
    busy: LicenseAction | null;
    error: string | null;
    pending: boolean;
    /** The full version is owned. */
    unlocked: boolean;
    /** How many tabs may be open at once; `null` once unlocked. */
    tabLimit: number | null;
    /** The full version as the store describes it, once the products are loaded. */
    product: IapProduct | undefined;
    /** The upgrade prompt is shown. */
    upgradeOpen: boolean;
    showUpgrade: () => void;
    dismissUpgrade: () => void;
    loadProducts: () => void;
    buy: () => void;
    restore: () => void;
    /** Ask the backend for the status again. */
    refresh: () => void;
}

const LicenseContext = createContext<LicenseContextType | undefined>(undefined);

/**
 * Mirrors the backend's purchase state (see `services::store` in Rust,
 * which is the only place that decides it) and carries the user's actions
 * on it. The free tier's limit is enforced here in the webview:
 * `WorkspaceProvider` asks `tabLimit` before opening a tab and calls
 * `showUpgrade` when it is reached. Renders nothing until the first status
 * has arrived, so the session restore at mount knows the limit.
 */
export function LicenseProvider({ children }: { children: ReactNode }) {
    const [model, dispatch] = useReducer(reduceLicense, INITIAL_LICENSE);

    const refresh = useCallback(() => {
        if (!isTauri()) {
            dispatch({ type: 'status', status: UNLOCKED });
            return;
        }
        getIapStatus()
            .then(status => dispatch({ type: 'status', status }))
            .catch(error => {
                console.error('Failed to read the purchase state:', error);
                // The free tier, with the reason: the app stays usable.
                dispatch({ type: 'status', status: { state: 'free', store_error: toErrorMessage(error), has_store: true } });
            });
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // A purchase approved elsewhere, or a refund, arrives from the store.
    useEffect(() => {
        if (!isTauri()) return;
        const unlisten = onIapStatus(status => dispatch({ type: 'status', status }));
        return () => {
            unlisten.then(fn => fn());
        };
    }, []);

    const loadProducts = useCallback(() => {
        if (!isTauri()) {
            dispatch({ type: 'products', products: [] });
            return;
        }
        listIapProducts()
            .then(products => dispatch({ type: 'products', products }))
            .catch(error => dispatch({ type: 'products-failed', error: toErrorMessage(error) }));
    }, []);

    // The products as of the last render, for the actions below.
    const productsRef = useRef(model.products);
    productsRef.current = model.products;

    const run = useCallback(async (action: LicenseAction, work: () => Promise<Omit<Extract<Parameters<typeof dispatch>[0], { type: 'action-done' }>, 'type' | 'action'>>) => {
        dispatch({ type: 'action-start', action });
        try {
            const done = await work();
            dispatch({ type: 'action-done', action, ...done });
        } catch (error) {
            dispatch({ type: 'action-failed', action, error: toErrorMessage(error) });
        }
    }, []);

    /** Buy the full version; the products are fetched first when they are not there yet. */
    const buy = useCallback(() => {
        run('buy', async () => {
            let products = productsRef.current;
            if (!products) {
                products = await listIapProducts();
                dispatch({ type: 'products', products });
            }
            const product = fullProduct(products);
            if (!product) {
                throw new Error('The App Store has no product for Parqsee');
            }
            const result = await purchaseProduct(product.id);
            return { status: result.status, outcome: result.outcome };
        });
    }, [run]);

    const restore = useCallback(() => {
        run('restore', async () => ({ status: await restorePurchases() }));
    }, [run]);

    const showUpgrade = useCallback(() => dispatch({ type: 'open-upgrade' }), []);
    const dismissUpgrade = useCallback(() => dispatch({ type: 'close-upgrade' }), []);

    const status = model.status;
    if (!status) return null;

    const value: LicenseContextType = {
        status,
        products: model.products,
        productsError: model.productsError,
        busy: model.busy,
        error: model.error,
        pending: model.pending,
        unlocked: status.state === 'unlocked',
        tabLimit: tabLimitFor(status),
        product: fullProduct(model.products),
        upgradeOpen: model.upgradeOpen,
        showUpgrade,
        dismissUpgrade,
        loadProducts,
        buy,
        restore,
        refresh,
    };

    return (
        <LicenseContext.Provider value={value}>
            {children}
        </LicenseContext.Provider>
    );
}

export function useLicense() {
    const context = useContext(LicenseContext);
    if (context === undefined) {
        throw new Error('useLicense must be used within a LicenseProvider');
    }
    return context;
}
