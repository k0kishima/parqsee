import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getFileName } from '../../../lib/path';

interface RestoreNoticeProps {
    /** The paths of the files the launch-time restore could not reopen. */
    skipped: readonly string[];
    onDismiss: () => void;
}

/**
 * One line at the bottom of the window naming the files of the last
 * session that could not be reopened (deleted, moved without their
 * bookmark, on a drive that is not mounted). The launch is not blocked;
 * the tabs are simply not there, and this says which.
 */
export function RestoreNotice({ skipped, onDismiss }: RestoreNoticeProps) {
    const { t } = useTranslation();
    return (
        <div
            role="status"
            data-testid="restore-notice"
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 max-w-xl w-[calc(100%-2rem)] flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg bg-primary border border-primary text-sm text-primary"
        >
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
                <p>{t('session.notReopened', { count: skipped.length })}</p>
                <p className="mt-0.5 text-xs text-tertiary truncate" title={skipped.join('\n')}>
                    {skipped.map(getFileName).join(', ')}
                </p>
            </div>
            <button
                onClick={onDismiss}
                className="shrink-0 p-1 rounded text-tertiary hover:text-primary hover:bg-tertiary transition-colors"
                title={t('common.dismiss')}
                aria-label={t('common.dismiss')}
            >
                <X size={14} />
            </button>
        </div>
    );
}
