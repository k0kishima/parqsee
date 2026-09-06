import { useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useLicense } from '../../../contexts/LicenseContext';
import { isTauri } from '../../../lib/tauri';
import { FREE_TAB_LIMIT } from '../lib/license';

/** Apple's purchase history, where a purchase can be reviewed or reported. */
const PURCHASE_HISTORY_URL = 'https://reportaproblem.apple.com/';

/**
 * Settings › Purchase, as a row of the settings dialog: the state in one
 * line with the way to Apple's purchase history under it, plus Buy /
 * Restore while on the free tier. The explanation of what the purchase
 * is lives in the upgrade prompt. Renders nothing in a build without a
 * store, where there is nothing to buy or restore.
 */
export function PurchaseSettings() {
    const { t } = useTranslation();
    const { status, unlocked, products, product, loadProducts, busy, error, pending, buy, restore } = useLicense();

    useEffect(() => {
        if (status.has_store && products === null && !unlocked) loadProducts();
    }, [status.has_store, products, unlocked, loadProducts]);

    if (!status.has_store) return null;

    const line = unlocked
        ? t('license.settings.unlocked')
        : t('license.settings.free', { count: FREE_TAB_LIMIT });

    const openHistory = () => {
        if (!isTauri()) return;
        openUrl(PURCHASE_HISTORY_URL).catch(e => console.error('Failed to open the purchase history:', e));
    };

    return (
        <div className="px-6 py-3 space-y-2">
            <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                    <p className="text-sm text-primary" data-testid="purchase-status">{line}</p>
                    <button onClick={openHistory} className="inline-flex items-center gap-1 text-xs text-tertiary hover:text-blue-500 transition-colors">
                        {t('license.settings.history')}
                        <ExternalLink size={12} />
                    </button>
                </div>
                {!unlocked && (
                    <div className="flex shrink-0 items-center gap-2">
                        <button onClick={buy} disabled={busy !== null} className="btn-primary disabled:opacity-50">
                            {product ? t('license.buyFor', { price: product.display_price }) : t('license.buy')}
                        </button>
                        <button onClick={restore} disabled={busy !== null} className="btn-secondary disabled:opacity-50">
                            {t('license.restore')}
                        </button>
                    </div>
                )}
            </div>
            {busy && <p className="text-xs text-tertiary">{t('license.working')}</p>}
            {status.store_error && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                    {t('license.storeError', { reason: status.store_error })}
                </p>
            )}
            {pending && <p className="text-xs text-amber-600 dark:text-amber-400">{t('license.pending')}</p>}
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
    );
}
