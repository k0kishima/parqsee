import { createContext, useContext, useEffect, useReducer, useCallback, useRef, useState, ReactNode } from 'react';
import { isTauri, toErrorMessage } from '../lib/tauri';
import {
    IapStatus,
    IapProduct,
    IapProductKind,
    getIapStatus,
    listIapProducts,
    purchaseProduct,
    restorePurchases,
    quitApp,
    onIapStatus,
} from '../features/license/api';
import { screenFor, isUsable, trialDaysLeft, msUntilTrialEnds, productOfKind, LicenseScreen } from '../features/license/lib/license';
import { reduceLicense, INITIAL_LICENSE, LicenseAction } from '../features/license/lib/license-reducer';

export type { IapStatus, IapProduct, LicenseScreen, LicenseAction };

/** What a build without a store answers, so the browser fallback behaves like one. */
const UNLOCKED: IapStatus = { state: 'unlocked', trial_ends_at: null, trial_days: 0, store_error: null };

/** How often the trial banner re-reads the clock. */
const TICK_MS = 60 * 60 * 1000;

interface LicenseContextType {
    status: IapStatus;
    /** `null` until `loadProducts` has run; empty in a build without a store. */
    products: IapProduct[] | null;
    productsError: string | null;
    busy: LicenseAction | null;
    error: string | null;
    pending: boolean;
    screen: LicenseScreen;
    /** True while the backend lets rows through. */
    usable: boolean;
    /** Whole days left in the trial (0 when there is none). */
    daysLeft: number;
    product: (kind: IapProductKind) => IapProduct | undefined;
    loadProducts: () => void;
    startTrial: () => void;
    buy: () => void;
    restore: () => void;
    /** Ask the backend for the status again. */
    refresh: () => void;
    quit: () => void;
}

const LicenseContext = createContext<LicenseContextType | undefined>(undefined);

/**
 * Mirrors the backend's trial / purchase state (see `services::store` in
 * Rust, which is the only place that decides it) and carries the user's
 * actions on it. Renders nothing until the first status has arrived, so
 * no child acts on an empty first render — the session restore in
 * `WorkspaceProvider` reads `usable` at mount.
 */
export function LicenseProvider({ children }: { children: ReactNode }) {
    const [model, dispatch] = useReducer(reduceLicense, INITIAL_LICENSE);
    const [now, setNow] = useState(() => Date.now());

    const refresh = useCallback(() => {
        if (!isTauri()) {
            dispatch({ type: 'status', status: UNLOCKED });
            return;
        }
        getIapStatus()
            .then(status => dispatch({ type: 'status', status }))
            .catch(error => {
                console.error('Failed to read the purchase state:', error);
                // Locked, with the reason: the backend refuses rows in this state too.
                dispatch({
                    type: 'status',
                    status: { state: 'none', trial_ends_at: null, trial_days: 0, store_error: toErrorMessage(error) },
                });
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

    // The trial ends while the app runs: ask again at that moment.
    const status = model.status;
    useEffect(() => {
        const wait = msUntilTrialEnds(status, Date.now());
        if (wait === null) return;
        const timer = setTimeout(() => {
            setNow(Date.now());
            refresh();
        }, wait);
        return () => clearTimeout(timer);
    }, [status, refresh]);

    useEffect(() => {
        if (status?.state !== 'trial') return;
        const timer = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(timer);
    }, [status?.state]);

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

    /** Buy the product of `kind`; the products are fetched first when they are not there yet. */
    const purchase = useCallback((action: LicenseAction, kind: IapProductKind) => {
        run(action, async () => {
            let products = productsRef.current;
            if (!products) {
                products = await listIapProducts();
                dispatch({ type: 'products', products });
            }
            const product = productOfKind(products, kind);
            if (!product) {
                throw new Error(`The App Store has no ${kind} product for Parqsee`);
            }
            const result = await purchaseProduct(product.id);
            return { status: result.status, outcome: result.outcome };
        });
    }, [run]);

    const startTrial = useCallback(() => purchase('trial', 'trial'), [purchase]);
    const buy = useCallback(() => purchase('buy', 'full'), [purchase]);
    const restore = useCallback(() => {
        run('restore', async () => ({ status: await restorePurchases() }));
    }, [run]);

    const quit = useCallback(() => {
        if (!isTauri()) return;
        quitApp().catch(error => console.error('Failed to quit:', error));
    }, []);

    if (!status) return null;

    const value: LicenseContextType = {
        status,
        products: model.products,
        productsError: model.productsError,
        busy: model.busy,
        error: model.error,
        pending: model.pending,
        screen: screenFor(status),
        usable: isUsable(status),
        daysLeft: trialDaysLeft(status, now),
        product: kind => productOfKind(model.products, kind),
        loadProducts,
        startTrial,
        buy,
        restore,
        refresh,
        quit,
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
