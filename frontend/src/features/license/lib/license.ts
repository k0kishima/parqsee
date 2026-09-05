import type { IapStatus, IapProduct } from '../api';

/**
 * How many tabs the free tier keeps open at once. Everything else — paging,
 * filters, search, the SQL view, export — is unrestricted; opening files is
 * the app's whole job, and comparing several at once is what the purchase
 * buys (#22). This is the only place the number lives: the backend has no
 * notion of a tab and enforces nothing.
 */
export const FREE_TAB_LIMIT = 3;

/**
 * The tab limit the status calls for: `null` (none) once the full version
 * is owned, `FREE_TAB_LIMIT` otherwise — including while the store could
 * not be read, when the app stays usable on the free tier rather than
 * locking.
 */
export function tabLimitFor(status: IapStatus | null): number | null {
    return status?.state === 'unlocked' ? null : FREE_TAB_LIMIT;
}

/** The full version among the products the store returned (there is only one). */
export function fullProduct(products: readonly IapProduct[] | null): IapProduct | undefined {
    return products?.[0];
}
