import { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLicense } from '../../../contexts/LicenseContext';
import { Modal, ModalCloseButton } from '../../../components/modal';
import { FREE_TAB_LIMIT } from '../lib/license';
import { PurchaseButtons } from './purchase-buttons';

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
        busy, error, pending, dismissUpgrade,
    } = useLicense();

    useEffect(() => {
        if (products === null) loadProducts();
    }, [products, loadProducts]);

    return (
        <Modal
            onClose={dismissUpgrade}
            labelledBy="upgrade-prompt-title"
            overlayClassName="z-[60] bg-black/40"
            panelClassName="max-w-lg"
            testId="upgrade-prompt"
        >
            <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-primary">
                <div className="flex items-center gap-3 min-w-0">
                    <Sparkles size={20} className="shrink-0 text-blue-500" />
                    <h2 id="upgrade-prompt-title" className="text-lg font-semibold text-primary">
                        {t('license.upgrade.title', { count: FREE_TAB_LIMIT })}
                    </h2>
                </div>
                <ModalCloseButton onClose={dismissUpgrade} className="shrink-0" />
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
                    <PurchaseButtons />
                </div>
                <button onClick={dismissUpgrade} className="text-sm text-tertiary hover:text-primary transition-colors">
                    {t('license.upgrade.notNow')}
                </button>
            </div>
        </Modal>
    );
}
