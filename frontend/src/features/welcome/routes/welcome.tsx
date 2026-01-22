import React from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettings } from '../../../contexts/SettingsContext';
import { WelcomeHeader } from '../components/welcome-header';
import { DropZone } from '../components/drop-zone';
import { RecentFilesList } from '../components/recent-files-list';
import { FeatureHighlights } from '../components/feature-highlights';

interface WelcomeProps {
    onFileSelect: (path: string) => void;
    onOpenSettings: () => void;
}

export const Welcome: React.FC<WelcomeProps> = ({ onFileSelect, onOpenSettings }) => {
    const { effectiveTheme } = useSettings();

    const handleBrowse = async () => {
        try {
            // Check if we can use Tauri APIs
            const isTauri = (window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__ || typeof open === 'function';

            if (isTauri) {
                const selected = await open({
                    filters: [{
                        name: 'Parquet Files',
                        extensions: ['parquet']
                    }]
                });

                if (selected && typeof selected === 'string') {
                    onFileSelect(selected);
                }
            } else {
                alert("File browser is only available in the desktop app. Please drag and drop a file instead.");
            }
        } catch (error) {
            console.error("Failed to select file:", error);
        }
    };

    return (
        <div className={`h-screen flex flex-col ${effectiveTheme === 'dark' ? 'bg-gray-900' : 'bg-slate-50'}`}>
            {/* Header */}
            <WelcomeHeader onBrowse={handleBrowse} onOpenSettings={onOpenSettings} />

            {/* Main Content */}
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-4xl mx-auto">
                    {/* Drop Zone */}
                    <DropZone onFileSelect={onFileSelect} onBrowse={handleBrowse} />

                    {/* Recent Files */}
                    <RecentFilesList onFileSelect={onFileSelect} />

                    {/* Features */}
                    <FeatureHighlights />
                </div>
            </div>
        </div>
    );
};
