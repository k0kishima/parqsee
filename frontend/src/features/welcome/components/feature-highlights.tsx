import React from 'react';
import { useTranslation } from 'react-i18next';
import { shortcutKeys } from '../../../lib/shortcuts';

interface FeatureHighlightsProps {
    /** The "Easy to Use" card promises shortcuts; this is where it shows them. */
    onShowShortcuts: () => void;
}

export const FeatureHighlights: React.FC<FeatureHighlightsProps> = ({ onShowShortcuts }) => {
    const { t } = useTranslation();

    return (
        /*
         * A container query, not a viewport one: the panel these cards sit in
         * is the window minus the sidebar, which the user resizes, so the
         * viewport width says little about the room a column has. Three
         * columns is the base, so a webview without container query support
         * (Safari 15 and older) keeps today's layout rather than one stacked
         * column on a wide screen.
         *
         * The text is left aligned: a column is ~280px at the widest the
         * container gets, and the descriptions wrap to two lines there
         * already — centring only reads well when wrapping is the exception.
         */
        <div className="mt-16 @container">
            <div className="grid grid-cols-3 gap-6 @max-xl:grid-cols-1">
                <div>
                    <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-100 text-blue-600 rounded-lg mb-3">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    </div>
                    <h4 className="font-medium mb-1 text-slate-900 dark:text-gray-200">{t('welcome.features.performance.title')}</h4>
                    <p className="text-sm text-slate-500 dark:text-gray-400">{t('welcome.features.performance.desc')}</p>
                </div>
                <div>
                    <div className="inline-flex items-center justify-center w-12 h-12 bg-green-100 text-green-600 rounded-lg mb-3">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>
                    <h4 className="font-medium mb-1 text-slate-900 dark:text-gray-200">{t('welcome.features.usability.title')}</h4>
                    <p className="text-sm text-slate-500 dark:text-gray-400">{t('welcome.features.usability.desc')}</p>
                    <button
                        type="button"
                        onClick={onShowShortcuts}
                        className="mt-1 text-sm text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                        {t('welcome.features.usability.link')}
                        <span className="ml-1.5 text-xs opacity-60">{shortcutKeys('shortcuts')}</span>
                    </button>
                </div>
                <div>
                    <div className="inline-flex items-center justify-center w-12 h-12 bg-purple-100 text-purple-600 rounded-lg mb-3">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                        </svg>
                    </div>
                    <h4 className="font-medium mb-1 text-slate-900 dark:text-gray-200">{t('welcome.features.largeFiles.title')}</h4>
                    <p className="text-sm text-slate-500 dark:text-gray-400">{t('welcome.features.largeFiles.desc')}</p>
                </div>
            </div>
        </div>
    );
};
