import { describe, it, expect } from 'vitest';
import { FREE_TAB_LIMIT, tabLimitFor, canOpenTab, fullProduct } from '../license';
import type { IapStatus, IapProduct } from '../../api';

const status = (partial: Partial<IapStatus>): IapStatus => ({ state: 'free', store_error: null, ...partial });

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

describe('canOpenTab', () => {
    it('allows up to the limit and no further', () => {
        expect(canOpenTab(0, 3)).toBe(true);
        expect(canOpenTab(2, 3)).toBe(true);
        expect(canOpenTab(3, 3)).toBe(false);
        expect(canOpenTab(7, 3)).toBe(false);
    });

    it('has no ceiling without a limit', () => {
        expect(canOpenTab(0, null)).toBe(true);
        expect(canOpenTab(100, null)).toBe(true);
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
