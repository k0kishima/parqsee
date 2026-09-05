import { useCallback, useEffect } from 'react';
import { Lock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLicense } from '../../../contexts/LicenseContext';
import { useGlobalKeydown } from '../../../hooks/useGlobalKeydown';

interface LicenseGateProps {
    /** `pretrial` before anything was started; `paywall` once the trial is over. */
    mode: 'pretrial' | 'paywall';
}

/**
 * The screen that stands between a locked app and its rows, over the
 * Welcome screen so it stays obvious what the app is. As Guideline 3.1.1
 * asks, it states the trial length, what stops working after it and the
 * price — the last fetched from the store so it is right in every
 * storefront. Escape and the close button quit: a locked app must never
 * trap the user (⌘Q works too).
 */
export function LicenseGate({ mode }: LicenseGateProps) {
    const { t } = useTranslation();
    const {
        status, products, productsError, product, loadProducts,
        busy, error, pending, startTrial, buy, restore, quit,
    } = useLicense();

    useEffect(() => {
        if (products === null) loadProducts();
    }, [products, loadProducts]);

    useGlobalKeydown(useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            quit();
        }
    }, [quit]));

    const full = product('full');
    const days = status.trial_days;
    const title = mode === 'pretrial' ? t('license.trialTitle', { count: days }) : t('license.expiredTitle');

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="license-gate-title"
            data-testid="license-gate"
            className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm"
        >
            <div className="w-full max-w-lg rounded-2xl shadow-2xl bg-primary border border-primary">
                <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-primary">
                    <div className="flex items-center gap-3 min-w-0">
                        <Lock size={20} className="shrink-0 text-blue-500" />
                        <h2 id="license-gate-title" className="text-lg font-semibold text-primary">{title}</h2>
                    </div>
                    <button
                        onClick={quit}
                        className="shrink-0 p-1.5 rounded-md text-tertiary hover:text-primary hover:bg-tertiary transition-colors"
                        title={t('license.quit')}
                        aria-label={t('license.quit')}
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="px-6 py-5 space-y-4 text-sm text-secondary">
                    <p>{mode === 'pretrial' ? t('license.trialIntro', { count: days }) : t('license.expiredIntro', { count: days })}</p>

                    <div>
                        <p className="text-primary">{t('license.lockedHeading')}</p>
                        <ul className="mt-1.5 ml-5 list-disc space-y-0.5">
                            <li>{t('license.locked.rows')}</li>
                            <li>{t('license.locked.sql')}</li>
                            <li>{t('license.locked.export')}</li>
                        </ul>
                        <p className="mt-1.5 text-xs text-tertiary">{t('license.stillWorks')}</p>
                    </div>

                    <p className="text-primary" data-testid="license-price">
                        {full
                            ? t('license.price', { price: full.display_price })
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
                        {mode === 'pretrial' && (
                            <button onClick={startTrial} disabled={busy !== null} className="btn-primary disabled:opacity-50">
                                {t('license.startTrial')}
                            </button>
                        )}
                        <button
                            onClick={buy}
                            disabled={busy !== null}
                            className={`${mode === 'pretrial' ? 'btn-secondary' : 'btn-primary'} disabled:opacity-50`}
                        >
                            {full ? t('license.buyFor', { price: full.display_price }) : t('license.buy')}
                        </button>
                        <button onClick={restore} disabled={busy !== null} className="btn-secondary disabled:opacity-50">
                            {t('license.restore')}
                        </button>
                    </div>
                    <button onClick={quit} className="text-sm text-tertiary hover:text-primary transition-colors">
                        {t('license.quit')}
                    </button>
                </div>
            </div>
        </div>
    );
}
