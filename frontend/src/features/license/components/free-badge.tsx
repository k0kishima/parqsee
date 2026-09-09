import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLicense } from '../../../contexts/LicenseContext';
import { FREE_TAB_LIMIT } from '../lib/license';

/**
 * A small "Free ⓘ" pill at the right end of the top row while the app is
 * on the free tier; nothing once unlocked. The whole pill is the button:
 * it opens the upgrade prompt, which is where the limit, the price and Buy
 * / Restore are explained — the row itself only says which version this
 * is. It sits in the header and in the tab bar alike, so the way to the
 * full version is in reach at the moment the limit bites (the tab bar has
 * the room: the free tier's three tabs are all it ever carries).
 */
export function FreeBadge() {
    const { t } = useTranslation();
    const { unlocked, showUpgrade } = useLicense();
    if (unlocked) return null;
    const label = t('license.badge.tooltip', { count: FREE_TAB_LIMIT });
    return (
        <button
            type="button"
            onClick={showUpgrade}
            data-testid="free-badge"
            title={label}
            aria-label={label}
            className="mr-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium bg-tertiary text-secondary border-primary hover:text-primary hover:border-secondary transition-colors"
        >
            <span>{t('license.badge.free')}</span>
            <Info size={13} className="shrink-0 text-blue-500" aria-hidden="true" />
        </button>
    );
}
