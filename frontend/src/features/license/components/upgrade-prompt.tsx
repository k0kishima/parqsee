import { useCallback, useEffect } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLicense } from '../../../contexts/LicenseContext';
import { useGlobalKeydown } from '../../../hooks/useGlobalKeydown';
import { FREE_TAB_LIMIT } from '../lib/license';

/**
 * The prompt shown when the free tier's limit is hit — the tab that would
 * have gone past `FREE_TAB_LIMIT` — or when the user asks from the Free
 * badge. It names the limit and the price (fetched from the store so it is
 * right in every storefront) with Buy / Restore, and is dismissible: Escape,
 * ✕ and the backdrop close it and leave the open tabs as they are. Nothing
 * here locks the app.
 */
export function UpgradePrompt() {
    const { t } = useTranslation();
    const {
        status, products, productsError, product, loadProducts,
        busy, error, pending, buy, restore, dismissUpgrade,
    } = useLicense();

    useEffect(() => {
        if (products === null) loadProducts();
    }, [products, loadProducts]);

    useGlobalKeydown(useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            dismissUpgrade();
        }
    }, [dismissUpgrade]));

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="upgrade-prompt-title"
            data-testid="upgrade-prompt"
            className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm"
            onClick={dismissUpgrade}
        >
            <div
                className="w-full max-w-lg rounded-2xl shadow-2xl bg-primary border border-primary"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-primary">
                    <div className="flex items-center gap-3 min-w-0">
                        <Sparkles size={20} className="shrink-0 text-blue-500" />
                        <h2 id="upgrade-prompt-title" className="text-lg font-semibold text-primary">
                            {t('license.upgrade.title', { count: FREE_TAB_LIMIT })}
                        </h2>
                    </div>
                    <button
                        onClick={dismissUpgrade}
                        className="shrink-0 p-1.5 rounded-md text-tertiary hover:text-primary hover:bg-tertiary transition-colors"
                        title={t('common.close')}
                        aria-label={t('common.close')}
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="px-6 py-5 space-y-4 text-sm text-secondary">
                    <p>{t('license.upgrade.intro', { count: FREE_TAB_LIMIT })}</p>
                    <p className="text-xs text-tertiary">{t('license.upgrade.stillWorks')}</p>

                    <p className="text-primary" data-testid="license-price">
                        {product
                            ? t('license.price', { price: product.display_price })
                            : productsError
                                ? (
                                    <>
                                        {t('license.priceError', { reason: productsError })}{' '}
                                        <button onClick={loadProducts} className="underline hover:text-blue-500">{t('license.retry')}</button>
                                    </>
                                )
                                : products
                                    ? t('license.priceUnavailable')
                                    : t('license.priceLoading')}
                    </p>

                    {status.store_error && (
                        <p role="alert" className="text-amber-600 dark:text-amber-400">
                            {t('license.storeError', { reason: status.store_error })}
                        </p>
                    )}
                    {pending && <p role="status" className="text-amber-600 dark:text-amber-400">{t('license.pending')}</p>}
                    {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
                    {busy && <p role="status" className="text-tertiary">{t('license.working')}</p>}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-primary">
                    <div className="flex flex-wrap items-center gap-2">
                        <button onClick={buy} disabled={busy !== null} className="btn-primary disabled:opacity-50">
                            {product ? t('license.buyFor', { price: product.display_price }) : t('license.buy')}
                        </button>
                        <button onClick={restore} disabled={busy !== null} className="btn-secondary disabled:opacity-50">
                            {t('license.restore')}
                        </button>
                    </div>
                    <button onClick={dismissUpgrade} className="text-sm text-tertiary hover:text-primary transition-colors">
                        {t('license.upgrade.notNow')}
                    </button>
                </div>
            </div>
        </div>
    );
}
