import { describe, it, expect } from 'vitest';
import { FREE_TAB_LIMIT, tabLimitFor, fullProduct } from '../license';
import type { IapStatus, IapProduct } from '../../api';

const status = (partial: Partial<IapStatus>): IapStatus => ({ state: 'free', store_error: null, has_store: true, ...partial });

describe('tabLimitFor', () => {
    it('is the free limit until the full version is owned', () => {
        expect(tabLimitFor(status({}))).toBe(FREE_TAB_LIMIT);
        expect(tabLimitFor(null)).toBe(FREE_TAB_LIMIT);
    });

    it('is lifted by the purchase', () => {
        expect(tabLimitFor(status({ state: 'unlocked' }))).toBeNull();
    });

    it('stays the free limit, not a lock, while the store cannot be read', () => {
        expect(tabLimitFor(status({ store_error: 'no network' }))).toBe(FREE_TAB_LIMIT);
    });
});

describe('fullProduct', () => {
    const full: IapProduct = { id: 'parqsee.full', display_name: 'Parqsee', description: '', display_price: '¥1,500' };

    it('is the one product the store returned', () => {
        expect(fullProduct([full])).toBe(full);
    });

    it('is undefined before the products are loaded or without a store', () => {
        expect(fullProduct(null)).toBeUndefined();
        expect(fullProduct([])).toBeUndefined();
    });
});
