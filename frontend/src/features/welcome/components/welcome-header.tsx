import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../../contexts/SettingsContext';

interface WelcomeHeaderProps {
    onBrowse: () => void;
    onOpenSettings: () => void;
}

export const WelcomeHeader: React.FC<WelcomeHeaderProps> = ({ onBrowse, onOpenSettings }) => {
    const { effectiveTheme } = useSettings();
    const { t } = useTranslation();

    return (
        <div className={`border-b shadow-sm ${effectiveTheme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-blue-100'}`}>
            <div className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center space-x-4">
                    <div className="flex items-center space-x-2">
                        <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center shadow-sm">
                            <span className="text-white font-bold text-sm">P</span>
                        </div>
                        <h1 className={`text-xl font-semibold ${effectiveTheme === 'dark' ? 'text-gray-100' : 'text-slate-900'}`}>{t('common.appName')}</h1>
                    </div>
                    <span className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-500'}`}>{t('welcome.subtitle')}</span>
                </div>
                <div className="flex items-center space-x-3">
                    <button
                        onClick={onBrowse}
                        className="inline-flex items-center px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors shadow-sm"
                    >
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                        {t('common.openFile')}
                    </button>
                    <button
                        onClick={onOpenSettings}
                        className={`p-2 rounded-md transition-colors ${effectiveTheme === 'dark'
                            ? 'text-gray-400 hover:bg-gray-700'
                            : 'text-gray-500 hover:bg-gray-100'
                            }`}
                        title={t('settings.title')}
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
};
