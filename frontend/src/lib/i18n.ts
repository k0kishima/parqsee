import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';


import ja from '../locales/ja.json';
import en from '../locales/en.json';
import { loadSettings } from './settings-storage';

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
        lng: loadSettings().language, // Initialize with saved language or default
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false, // react already safes from xss
        },
    });

export default i18n;
