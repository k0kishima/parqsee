import React from 'react';
import { WelcomeHeader } from '../components/welcome-header';
import { DropZone } from '../components/drop-zone';
import { RecentFilesList } from '../components/recent-files-list';
import { FeatureHighlights } from '../components/feature-highlights';

interface WelcomeProps {
    onFileSelect: (path: string) => void;
    onBrowse: () => void;
    onOpenSettings: () => void;
}

export const Welcome: React.FC<WelcomeProps> = ({ onFileSelect, onBrowse, onOpenSettings }) => {
    return (
        <div className="h-screen flex flex-col bg-slate-50 dark:bg-gray-900">
            {/* Header */}
            <WelcomeHeader onBrowse={onBrowse} onOpenSettings={onOpenSettings} />

            {/* Main Content */}
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-4xl mx-auto">
                    {/* Drop Zone */}
                    <DropZone onFileSelect={onFileSelect} onBrowse={onBrowse} />

                    {/* Recent Files */}
                    <RecentFilesList onFileSelect={onFileSelect} />

                    {/* Features */}
                    <FeatureHighlights />
                </div>
            </div>
        </div>
    );
};
