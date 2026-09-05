import { useTranslation } from 'react-i18next';
import { useLicense } from '../../../contexts/LicenseContext';

/**
 * "Trial · N days left · Buy" in the header while the trial runs; nothing
 * otherwise. A failed purchase shows its reason next to the button.
 */
export function TrialBanner() {
    const { t } = useTranslation();
    const { status, daysLeft, busy, error, buy } = useLicense();
    if (status.state !== 'trial') return null;
    return (
        <div
            data-testid="trial-banner"
            className="flex items-center gap-2 px-2.5 py-1 rounded-md text-xs bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
        >
            <span>{t('license.banner.daysLeft', { count: daysLeft })}</span>
            <span aria-hidden="true">·</span>
            <button
                onClick={buy}
                disabled={busy !== null}
                className="font-medium underline hover:text-amber-950 dark:hover:text-white disabled:opacity-50"
            >
                {t('license.buy')}
            </button>
            {error && <span className="text-red-600 dark:text-red-400 truncate max-w-xs" title={error}>{error}</span>}
        </div>
    );
}
