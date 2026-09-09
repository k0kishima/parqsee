import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpgradePrompt } from '../upgrade-prompt';
import type { IapProduct, IapStatus } from '../../api';

const FULL: IapProduct = { id: 'parqsee.full', display_name: 'Parqsee Full Version', description: '', display_price: '¥1,500' };
const FREE: IapStatus = { state: 'free', store_error: null, has_store: true };

// The mocked `t` (test/setup.ts) answers an unknown key with the key itself,
// interpolation dropped, so the price and the reasons are asserted by key.

/** The license as the prompt sees it; each test sets the state it is about. */
const license = vi.hoisted(() => ({
  status: { state: 'free', store_error: null, has_store: true } as IapStatus,
  products: null as IapProduct[] | null,
  productsError: null as string | null,
  product: undefined as IapProduct | undefined,
  loadProducts: vi.fn(),
  busy: null as 'buy' | 'restore' | null,
  error: null as string | null,
  pending: false,
  buy: vi.fn(),
  restore: vi.fn(),
  dismissUpgrade: vi.fn(),
}));
vi.mock('../../../../contexts/LicenseContext', () => ({ useLicense: () => license }));

const withProducts = (products: IapProduct[]) => {
  license.products = products;
  license.product = products[0];
};

describe('UpgradePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    license.status = FREE;
    license.products = null;
    license.productsError = null;
    license.product = undefined;
    license.busy = null;
    license.error = null;
    license.pending = false;
  });

  it('asks for the products once and shows the price on Buy while they load', () => {
    render(<UpgradePrompt />);

    expect(license.loadProducts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('license-price')).toHaveTextContent('license.priceLoading');
    expect(screen.getByRole('button', { name: 'license.buy' })).toBeInTheDocument();
  });

  it('shows the storefront price and buys for it', async () => {
    withProducts([FULL]);
    render(<UpgradePrompt />);

    expect(license.loadProducts).not.toHaveBeenCalled();
    expect(screen.getByTestId('license-price')).toHaveTextContent('license.price');
    await userEvent.click(screen.getByRole('button', { name: 'license.buyFor' }));
    expect(license.buy).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'license.restore' }));
    expect(license.restore).toHaveBeenCalledTimes(1);
  });

  it('says so when the store has no product (an unsigned build)', () => {
    withProducts([]);
    render(<UpgradePrompt />);
    expect(screen.getByTestId('license-price')).toHaveTextContent('license.priceUnavailable');
  });

  it('offers a retry when the products could not be loaded', async () => {
    license.productsError = 'timed out';
    render(<UpgradePrompt />);

    // The first load runs at mount; the retry is a second one.
    expect(screen.getByTestId('license-price')).toHaveTextContent('license.priceError');
    await userEvent.click(screen.getByRole('button', { name: 'license.retry' }));
    expect(license.loadProducts).toHaveBeenCalledTimes(2);
  });

  it('shows a store that could not be read, a pending purchase and a failed one', () => {
    withProducts([FULL]);
    license.status = { ...FREE, store_error: 'receipt' };
    license.pending = true;
    license.error = 'declined';
    render(<UpgradePrompt />);

    expect(screen.getAllByRole('alert').map(el => el.textContent)).toEqual(['license.storeError', 'declined']);
    expect(screen.getByRole('status')).toHaveTextContent('license.pending');
  });

  it('disables Buy and Restore while the store is being contacted', () => {
    withProducts([FULL]);
    license.busy = 'buy';
    render(<UpgradePrompt />);

    expect(screen.getByRole('button', { name: 'license.buyFor' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'license.restore' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('license.working');
  });

  it('closes from ✕, Not now, the backdrop and Escape, never from inside', async () => {
    withProducts([FULL]);
    render(<UpgradePrompt />);

    await userEvent.click(screen.getByRole('button', { name: 'common.close' }));
    await userEvent.click(screen.getByRole('button', { name: 'license.upgrade.notNow' }));
    await userEvent.click(screen.getByTestId('upgrade-prompt'));
    await userEvent.keyboard('{Escape}');
    expect(license.dismissUpgrade).toHaveBeenCalledTimes(4);

    await userEvent.click(screen.getByTestId('license-price'));
    expect(license.dismissUpgrade).toHaveBeenCalledTimes(4);
  });
});
