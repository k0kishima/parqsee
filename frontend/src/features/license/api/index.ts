import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { IapStatus } from '../../../bindings/ipc/IapStatus';
import type { IapState } from '../../../bindings/ipc/IapState';
import type { IapProduct } from '../../../bindings/ipc/IapProduct';
import type { IapPurchaseResult } from '../../../bindings/ipc/IapPurchaseResult';
import type { IapPurchaseOutcome } from '../../../bindings/ipc/IapPurchaseOutcome';

export type { IapStatus, IapState, IapProduct, IapPurchaseResult, IapPurchaseOutcome };

/**
 * Whether the full version is owned. The backend derives it from the App
 * Store entitlements on every call; the webview never stores it. Waits for
 * the launch-time read.
 */
export const getIapStatus = async (): Promise<IapStatus> => {
    return await invoke('iap_status');
};

/** The full version with the storefront's name and price (one product); empty without a store. */
export const listIapProducts = async (): Promise<IapProduct[]> => {
    return await invoke('iap_products');
};

/** Buy a product by the id `listIapProducts` returned. */
export const purchaseProduct = async (productId: string): Promise<IapPurchaseResult> => {
    return await invoke('iap_purchase', { productId });
};

/** Restore Purchases; resolves to the status afterwards. */
export const restorePurchases = async (): Promise<IapStatus> => {
    return await invoke('iap_restore');
};

/**
 * The status the backend pushes after a transaction update from the store
 * (a purchase approved elsewhere, a refund).
 */
export const onIapStatus = (handler: (status: IapStatus) => void): Promise<UnlistenFn> => {
    return listen<IapStatus>('iap-status', event => handler(event.payload));
};
