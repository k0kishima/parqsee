import type { IapStatus, IapProduct, IapPurchaseOutcome } from '../api';

/** What the user asked the store to do. */
export type LicenseAction = 'buy' | 'restore';

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
    /** The upgrade prompt is shown (the free tier's limit was hit, or the user asked). */
    upgradeOpen: boolean;
}

export const INITIAL_LICENSE: LicenseModel = {
    status: null,
    products: null,
    productsError: null,
    busy: null,
    error: null,
    pending: false,
    upgradeOpen: false,
};

export type LicenseEvent =
    /** From `iap_status` or from the `iap-status` event. */
    | { type: 'status'; status: IapStatus }
    | { type: 'products'; products: IapProduct[] }
    | { type: 'products-failed'; error: string }
    | { type: 'action-start'; action: LicenseAction }
    | { type: 'action-done'; action: LicenseAction; status: IapStatus; outcome?: IapPurchaseOutcome }
    | { type: 'action-failed'; action: LicenseAction; error: string }
    | { type: 'open-upgrade' }
    | { type: 'close-upgrade' };

/**
 * The webview's side of the license: it mirrors the backend's status and
 * tracks what the user is doing about it. The state itself (free →
 * unlocked, and back on a refund) only ever arrives as a new `status` from
 * the backend; nothing here computes one. An unlocked status settles a
 * pending purchase and closes the upgrade prompt.
 */
export function reduceLicense(model: LicenseModel, event: LicenseEvent): LicenseModel {
    switch (event.type) {
        case 'status':
            return withStatus(model, event.status);
        case 'products':
            return { ...model, products: event.products, productsError: null };
        case 'products-failed':
            return { ...model, productsError: event.error };
        case 'action-start':
            return { ...model, busy: event.action, error: null };
        case 'action-done':
            return {
                ...withStatus(model, event.status),
                busy: null,
                error: null,
                pending: event.outcome === 'pending' ? true : model.pending && event.status.state !== 'unlocked',
            };
        case 'action-failed':
            return { ...model, busy: null, error: event.error };
        case 'open-upgrade':
            return { ...model, upgradeOpen: true };
        case 'close-upgrade':
            return { ...model, upgradeOpen: false };
    }
}

function withStatus(model: LicenseModel, status: IapStatus): LicenseModel {
    const unlocked = status.state === 'unlocked';
    return {
        ...model,
        status,
        pending: model.pending && !unlocked,
        upgradeOpen: model.upgradeOpen && !unlocked,
    };
}
