import { useTranslation } from 'react-i18next';
import { useLicense } from '../../../contexts/LicenseContext';

/**
 * "Free · Upgrade" in the header while the app is on the free tier; nothing
 * once unlocked. The link opens the upgrade prompt.
 */
export function FreeBadge() {
    const { t } = useTranslation();
    const { unlocked, showUpgrade } = useLicense();
    if (unlocked) return null;
    return (
        <div
            data-testid="free-badge"
            className="flex items-center gap-2 px-2.5 py-1 rounded-md text-xs bg-tertiary text-secondary"
        >
            <span>{t('license.badge.free')}</span>
            <span aria-hidden="true">·</span>
            <button
                onClick={showUpgrade}
                className="font-medium underline text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
                {t('license.badge.upgrade')}
            </button>
        </div>
    );
}
