import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getFileName } from '../../../lib/path';
import { FREE_TAB_LIMIT } from '../../license/lib/license';

interface RestoreNoticeProps {
    /** The paths of the files the launch-time restore could not reopen. */
    skipped: readonly string[];
    /** The paths of the tabs left out because the free tier's limit was reached. */
    capped: readonly string[];
    onDismiss: () => void;
    /** Open the upgrade prompt (shown with `capped`). */
    onUpgrade: () => void;
}

/**
 * One line at the bottom of the window naming what of the last session
 * did not come back: the files that could not be reopened (deleted, moved
 * without their bookmark, on a drive that is not mounted), and on the free
 * tier the tabs past its limit. The launch is not blocked; the tabs are
 * simply not there, and this says which. It is tinted amber rather than
 * drawn like a panel: it appears over a grid that looks complete, and a
 * neutral card at the bottom edge reads as part of the window.
 */
export function RestoreNotice({ skipped, capped, onDismiss, onUpgrade }: RestoreNoticeProps) {
    const { t } = useTranslation();
    return (
        <div
            role="status"
            data-testid="restore-notice"
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 max-w-xl w-[calc(100%-2rem)] flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg border text-sm bg-amber-50 border-amber-300 text-amber-950 dark:bg-amber-950 dark:border-amber-700 dark:text-amber-50"
        >
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1 space-y-2">
                {skipped.length > 0 && (
                    <div>
                        <p>{t('session.notReopened', { count: skipped.length })}</p>
                        <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-200/70 truncate" title={skipped.join('\n')}>
                            {skipped.map(getFileName).join(', ')}
                        </p>
                    </div>
                )}
                {capped.length > 0 && (
                    <div data-testid="restore-notice-capped">
                        <p>
                            {t('session.notRestoredFree', { count: capped.length, limit: FREE_TAB_LIMIT })}{' '}
                            <button onClick={onUpgrade} className="font-medium underline hover:text-amber-700 dark:hover:text-amber-200 transition-colors">
                                {t('license.upgradeLink')}
                            </button>
                        </p>
                        <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-200/70 truncate" title={capped.join('\n')}>
                            {capped.map(getFileName).join(', ')}
                        </p>
                    </div>
                )}
            </div>
            <button
                onClick={onDismiss}
                className="shrink-0 p-1 rounded text-amber-700 hover:text-amber-950 hover:bg-amber-100 dark:text-amber-300 dark:hover:text-amber-50 dark:hover:bg-amber-900 transition-colors"
                title={t('common.dismiss')}
                aria-label={t('common.dismiss')}
            >
                <X size={14} />
            </button>
        </div>
    );
}
