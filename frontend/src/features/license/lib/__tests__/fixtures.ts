import type { IapProduct, IapStatus } from '../../api';

/** A status the store could report; the free tier with a store unless overridden. */
export const iapStatus = (partial: Partial<IapStatus> = {}): IapStatus =>
    ({ state: 'free', store_error: null, has_store: true, ...partial });

export const FREE = iapStatus();
export const UNLOCKED = iapStatus({ state: 'unlocked' });

/** The full version as App Store Connect would describe it in one storefront. */
export const FULL_PRODUCT: IapProduct = {
    id: 'parqsee.full', display_name: 'Parqsee Full Version', description: '', display_price: '¥1,500',
};
