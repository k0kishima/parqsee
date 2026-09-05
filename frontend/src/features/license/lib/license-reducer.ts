import type { IapStatus, IapProduct, IapPurchaseOutcome } from '../api';

/** What the user asked the store to do. */
export type LicenseAction = 'trial' | 'buy' | 'restore';

export interface LicenseModel {
    /** `null` until the backend has answered. */
    status: IapStatus | null;
    /** `null` until loaded; an empty list is a build without a store. */
    products: IapProduct[] | null;
    productsError: string | null;
    /** The action in flight, if any; the buttons disable while one is. */
    busy: LicenseAction | null;
    /** Why the last action failed; cleared when the next one starts. */
    error: string | null;
    /** A purchase the store is still deciding on (Ask to Buy). */
    pending: boolean;
}

export const INITIAL_LICENSE: LicenseModel = {
    status: null,
    products: null,
    productsError: null,
    busy: null,
    error: null,
    pending: false,
};

export type LicenseEvent =
    /** From `iap_status`, from the `iap-status` event, or after a timer. */
    | { type: 'status'; status: IapStatus }
    | { type: 'products'; products: IapProduct[] }
    | { type: 'products-failed'; error: string }
    | { type: 'action-start'; action: LicenseAction }
    | { type: 'action-done'; action: LicenseAction; status: IapStatus; outcome?: IapPurchaseOutcome }
    | { type: 'action-failed'; action: LicenseAction; error: string };

/**
 * The webview's side of the license: it only mirrors the backend's status
 * and tracks what the user is doing about it. Every transition of the
 * state itself (none → trial → trial_expired → unlocked) arrives as a new
 * `status` from the backend; nothing here computes one.
 */
export function reduceLicense(model: LicenseModel, event: LicenseEvent): LicenseModel {
    switch (event.type) {
        case 'status':
            return {
                ...model,
                status: event.status,
                // A status that unlocked or started the trial settles the pending purchase.
                pending: model.pending && event.status.state !== 'unlocked' && event.status.state !== 'trial',
            };
        case 'products':
            return { ...model, products: event.products, productsError: null };
        case 'products-failed':
            return { ...model, productsError: event.error };
        case 'action-start':
            return { ...model, busy: event.action, error: null };
        case 'action-done':
            return {
                ...model,
                busy: null,
                error: null,
                status: event.status,
                pending: event.outcome === 'pending'
                    ? true
                    : model.pending && event.status.state !== 'unlocked' && event.status.state !== 'trial',
            };
        case 'action-failed':
            return { ...model, busy: null, error: event.error };
    }
}
