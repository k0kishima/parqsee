import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';


import ja from '../locales/ja.json';
import en from '../locales/en.json';

// Basic typed interface for reading settings from localStorage without full context overhead
interface SavedSettings {
    language?: 'en' | 'ja';
}

const getSavedLanguage = (): 'en' | 'ja' => {
    try {
        const saved = localStorage.getItem('parqsee-settings');
        if (saved) {
            const parsed = JSON.parse(saved) as SavedSettings;
            if (parsed.language === 'en' || parsed.language === 'ja') {
                return parsed.language;
            }
        }
    } catch (e) {
        console.error('Failed to parse settings for language', e);
    }
    return 'en'; // Default fallback
};

i18n
    .use(initReactI18next)
    .init({
        resources: {
            en: {
                translation: en,
            },
            ja: {
                translation: ja,
            },
        },
        lng: getSavedLanguage(), // Initialize with saved language or default
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false, // react already safes from xss
        },
    });

export default i18n;
