import React, { useState, useCallback, DragEvent } from 'react';

import { useSettings } from '../../../contexts/SettingsContext';

interface DropZoneProps {
    onFileSelect: (path: string) => void;
    onBrowse: () => void;
}

export const DropZone: React.FC<DropZoneProps> = ({ onFileSelect, onBrowse }) => {
    const { effectiveTheme } = useSettings();
    const [isDragging, setIsDragging] = useState(false);

    const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        console.log('Web drop event:', e.dataTransfer);

        // Check if we have files in dataTransfer
        // Note: Tauri's native file-drop event is handled globally in App.tsx
        // This handles browser-style drops if they happen
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            const file = files[0];
            // For web drops, we might have file object but path might be restricted
            // In Tauri webview with fileDropEnabled: false (default), this might not trigger with paths
            // However, if we get a file with path (Tauri custom), use it
            if ((file as any).path && (file as any).name.endsWith('.parquet')) {
                onFileSelect((file as any).path);
            }
        }
    }, [onFileSelect]);

    return (
        <div
            className={`
              relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-200
              ${isDragging
                    ? 'border-blue-500 bg-blue-50 shadow-lg transform scale-[1.02]'
                    : effectiveTheme === 'dark'
                        ? 'border-gray-700 bg-gray-800 hover:border-gray-600'
                        : 'border-blue-200 bg-white hover:border-blue-300 hover:shadow-md'
                }
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div className="px-12 py-16 text-center">
                <div className={`inline-flex items-center justify-center w-20 h-20 rounded-full mb-6 transition-colors ${isDragging ? 'bg-blue-100' : (effectiveTheme === 'dark' ? 'bg-gray-700' : 'bg-blue-50')
                    }`}>
                    <svg
                        className={`w-10 h-10 transition-colors ${isDragging ? 'text-blue-600' : (effectiveTheme === 'dark' ? 'text-gray-400' : 'text-blue-400')
                            }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                    </svg>
                </div>

                <h2 className={`text-xl font-semibold mb-2 ${effectiveTheme === 'dark' ? 'text-gray-100' : 'text-slate-900'}`}>
                    Drop your Parquet file here
                </h2>
                <p className={`text-sm mb-6 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-500'}`}>
                    or click the button below to browse
                </p>

                <button
                    onClick={onBrowse}
                    className={`inline-flex items-center px-6 py-2.5 text-sm text-white rounded-lg transition-colors ${effectiveTheme === 'dark' ? 'bg-gray-700 hover:bg-gray-600' : 'bg-slate-900 hover:bg-slate-800'
                        }`}
                >
                    Browse Files
                </button>

                <p className={`mt-6 text-xs ${effectiveTheme === 'dark' ? 'text-gray-500' : 'text-slate-400'}`}>
                    Supports .parquet files • Press ⌘+O to open
                </p>
            </div>

            {/* Decorative elements */}
            <div className="absolute top-0 right-0 -mt-12 -mr-12 w-40 h-40 bg-blue-100 rounded-full opacity-10"></div>
            <div className="absolute bottom-0 left-0 -mb-12 -ml-12 w-32 h-32 bg-purple-100 rounded-full opacity-10"></div>
        </div>
    );
};
