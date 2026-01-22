import React from 'react';
import { useSettings } from '../../../contexts/SettingsContext';
import { useRecentFiles } from '../../../contexts/RecentFilesContext';

interface RecentFilesListProps {
    onFileSelect: (path: string) => void;
}

export const RecentFilesList: React.FC<RecentFilesListProps> = ({ onFileSelect }) => {
    const { settings, effectiveTheme } = useSettings();
    const { recentFiles, removeRecentFile } = useRecentFiles();

    if (!settings?.showRecentFiles) {
        return null;
    }

    const formatFileSize = (bytes: number): string => {
        if (bytes < 1024) return bytes + ' B';
        else if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
        else if (bytes < 1073741824) return Math.round(bytes / 1048576) + ' MB';
        else return Math.round(bytes / 1073741824) + ' GB';
    };

    return (
        <div className="mt-12">
            <h3 className={`text-lg font-semibold mb-4 flex items-center ${effectiveTheme === 'dark' ? 'text-gray-200' : 'text-slate-800'}`}>
                <svg className={`w-5 h-5 mr-2 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Recent Files
            </h3>
            <div className="space-y-2">
                {recentFiles.length === 0 ? (
                    <p className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-500' : 'text-slate-500'}`}>No recent files yet. Open a Parquet file to see it here.</p>
                ) : (
                    recentFiles.map((file) => (
                        <div
                            key={file.path}
                            className={`w-full flex items-center rounded-lg border transition-all group ${effectiveTheme === 'dark'
                                ? 'bg-gray-800 border-gray-700 hover:border-gray-600'
                                : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'
                                }`}
                        >
                            <button
                                onClick={() => onFileSelect(file.path)}
                                className="flex-1 text-left p-4"
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center space-x-3">
                                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${effectiveTheme === 'dark'
                                            ? 'bg-gray-700 group-hover:bg-gray-600'
                                            : 'bg-slate-100 group-hover:bg-blue-50'
                                            }`}>
                                            <svg className={`w-5 h-5 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                        </div>
                                        <div>
                                            <p className={`font-medium transition-colors ${effectiveTheme === 'dark'
                                                ? 'text-gray-200 group-hover:text-blue-400'
                                                : 'text-slate-700 group-hover:text-blue-600'
                                                }`}>
                                                {file.name}
                                            </p>
                                            <p className={`text-sm ${effectiveTheme === 'dark' ? 'text-gray-500' : 'text-slate-500'}`}>
                                                {file.path}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className={`text-sm font-medium ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-600'}`}>
                                            {formatFileSize(file.size)}
                                        </p>
                                        <p className={`text-xs ${effectiveTheme === 'dark' ? 'text-gray-500' : 'text-slate-500'}`}>
                                            {file.lastAccessed}
                                        </p>
                                    </div>
                                </div>
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    removeRecentFile(file.path);
                                }}
                                className={`p-4 transition-colors ${effectiveTheme === 'dark'
                                    ? 'text-gray-500 hover:text-red-400'
                                    : 'text-slate-400 hover:text-red-500'
                                    }`}
                                title="Remove from recent files"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};
