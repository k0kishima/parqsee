import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../../contexts/SettingsContext';

interface QueryEditorProps {
    onExecute: (query: string) => void;
    isLoading: boolean;
}

export const QueryEditor: React.FC<QueryEditorProps> = ({ onExecute, isLoading }) => {
    const { t } = useTranslation();
    const { effectiveTheme } = useSettings();
    const [query, setQuery] = useState('SELECT * FROM t LIMIT 100;');

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            onExecute(query);
        }
    };

    const containerBg = effectiveTheme === 'dark' ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200';
    const toolbarBg = effectiveTheme === 'dark' ? 'bg-gray-800 border-gray-800' : 'bg-gray-50 border-gray-200';
    const textareaColor = effectiveTheme === 'dark' ? 'text-gray-100' : 'text-gray-900';
    const buttonBg = isLoading
        ? (effectiveTheme === 'dark' ? 'bg-gray-700 text-gray-500' : 'bg-gray-100 text-gray-400')
        : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm';

    return (
        <div className={`flex flex-col h-full border-b ${containerBg}`}>
            <div className={`p-2 border-b flex justify-between items-center ${toolbarBg}`}>
                <span className="text-xs text-gray-500 font-mono">Table name: t</span>
                <button
                    onClick={() => onExecute(query)}
                    disabled={isLoading}
                    className={`
                        flex items-center gap-2 px-4 py-1.5 rounded text-sm font-medium transition-colors
                        ${buttonBg} ${isLoading ? 'cursor-not-allowed' : ''}
                    `}
                >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    {isLoading ? t('viewer.query.running') : t('viewer.query.run')}
                </button>
            </div>
            <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                className={`flex-1 w-full p-4 font-mono text-sm resize-none focus:outline-none bg-transparent ${textareaColor}`}
                placeholder="Write your SQL query here... (e.g., SELECT * FROM t)"
                spellCheck={false}
            />
        </div>
    );
};
