import { describe, it, expect } from 'vitest';
import { FREE_TAB_LIMIT, tabLimitFor, fullProduct } from '../license';
import type { IapProduct } from '../../api';
import { iapStatus } from './fixtures';

describe('tabLimitFor', () => {
    it('is the free limit until the full version is owned', () => {
        expect(tabLimitFor(iapStatus({}))).toBe(FREE_TAB_LIMIT);
        expect(tabLimitFor(null)).toBe(FREE_TAB_LIMIT);
    });

    it('is lifted by the purchase', () => {
        expect(tabLimitFor(iapStatus({ state: 'unlocked' }))).toBeNull();
    });

    it('stays the free limit, not a lock, while the store cannot be read', () => {
        expect(tabLimitFor(iapStatus({ store_error: 'no network' }))).toBe(FREE_TAB_LIMIT);
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
