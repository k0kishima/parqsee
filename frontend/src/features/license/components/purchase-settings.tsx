import { useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useLicense } from '../../../contexts/LicenseContext';
import { isTauri } from '../../../lib/tauri';

/** Apple's purchase history, where a purchase can be reviewed or reported. */
const PURCHASE_HISTORY_URL = 'https://reportaproblem.apple.com/';

/**
 * Settings → Purchase: the state in one line, Buy / Restore while the app
 * is not unlocked, and the way to Apple's purchase history.
 */
export function PurchaseSettings() {
    const { t } = useTranslation();
    const { status, daysLeft, products, product, loadProducts, busy, error, pending, buy, restore } = useLicense();

    useEffect(() => {
        if (products === null && status.state !== 'unlocked') loadProducts();
    }, [products, status.state, loadProducts]);

    const full = product('full');
    const line = (() => {
        switch (status.state) {
            case 'unlocked': return t('license.settings.unlocked');
            case 'trial': return t('license.settings.trial', { count: daysLeft });
            case 'trial_expired': return t('license.settings.expired');
            case 'none': return t('license.settings.none');
        }
    })();

    const openHistory = () => {
        if (!isTauri()) return;
        openUrl(PURCHASE_HISTORY_URL).catch(e => console.error('Failed to open the purchase history:', e));
    };

    return (
        <div>
            <label className="block text-sm font-medium text-secondary mb-2">
                {t('license.settings.title')}
            </label>
            <div className="space-y-3">
                <p className="text-sm text-primary" data-testid="purchase-status">{line}</p>
                {status.store_error && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                        {t('license.storeError', { reason: status.store_error })}
                    </p>
                )}
                {status.state !== 'unlocked' && (
                    <div className="flex flex-wrap items-center gap-2">
                        <button onClick={buy} disabled={busy !== null} className="btn-primary disabled:opacity-50">
                            {full ? t('license.buyFor', { price: full.display_price }) : t('license.buy')}
                        </button>
                        <button onClick={restore} disabled={busy !== null} className="btn-secondary disabled:opacity-50">
                            {t('license.restore')}
                        </button>
                        {busy && <span className="text-xs text-tertiary">{t('license.working')}</span>}
                    </div>
                )}
                {pending && <p className="text-xs text-amber-600 dark:text-amber-400">{t('license.pending')}</p>}
                {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
                <button onClick={openHistory} className="inline-flex items-center gap-1 text-xs text-secondary hover:text-blue-500 transition-colors">
                    {t('license.settings.history')}
                    <ExternalLink size={12} />
                </button>
                <p className="text-xs text-tertiary">{t('license.settings.desc')}</p>
            </div>
        </div>
    );
}
