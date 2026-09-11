import { useTranslation } from 'react-i18next';
import { useLicense } from '../../../contexts/LicenseContext';

/**
 * Buy / Restore, as the upgrade prompt and Settings › Purchase show them:
 * the price on the Buy button once the store has answered, both disabled
 * while a purchase or a restore is in flight.
 */
export function PurchaseButtons() {
    const { t } = useTranslation();
    const { product, busy, buy, restore } = useLicense();
    return (
        <>
            <button onClick={buy} disabled={busy !== null} className="btn-primary disabled:opacity-50">
                {product ? t('license.buyFor', { price: product.display_price }) : t('license.buy')}
            </button>
            <button onClick={restore} disabled={busy !== null} className="btn-secondary disabled:opacity-50">
                {t('license.restore')}
            </button>
        </>
    );
}
