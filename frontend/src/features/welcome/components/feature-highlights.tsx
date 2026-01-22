import React from 'react';
import { useSettings } from '../../../contexts/SettingsContext';

export const FeatureHighlights: React.FC = () => {
    const { effectiveTheme } = useSettings();

    return (
        <div className="mt-16 grid grid-cols-3 gap-6">
            <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-100 text-blue-600 rounded-lg mb-3">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                </div>
                <h4 className={`font-medium mb-1 ${effectiveTheme === 'dark' ? 'text-gray-200' : 'text-slate-900'}`}>Fast Performance</h4>
                <p className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-500'}`}>Native Rust backend for blazing fast file processing</p>
            </div>
            <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 bg-green-100 text-green-600 rounded-lg mb-3">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </div>
                <h4 className={`font-medium mb-1 ${effectiveTheme === 'dark' ? 'text-gray-200' : 'text-slate-900'}`}>Easy to Use</h4>
                <p className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-500'}`}>Simple drag & drop interface with keyboard shortcuts</p>
            </div>
            <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 bg-purple-100 text-purple-600 rounded-lg mb-3">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                    </svg>
                </div>
                <h4 className={`font-medium mb-1 ${effectiveTheme === 'dark' ? 'text-gray-200' : 'text-slate-900'}`}>Large Files</h4>
                <p className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-500'}`}>Efficient pagination for handling massive datasets</p>
            </div>
        </div>
    );
};
