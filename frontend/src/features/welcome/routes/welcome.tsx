import React from 'react';
import { WelcomeHeader } from '../components/welcome-header';
import { DropZone } from '../components/drop-zone';
import { RecentFilesList } from '../components/recent-files-list';
import { FeatureHighlights } from '../components/feature-highlights';

interface WelcomeContentProps {
    onFileSelect: (path: string) => void;
    onBrowse: () => void;
    onOpenFolder: () => void;
    onOpenSample: () => void;
}

/**
 * The drop zone, recent files and feature cards. Shown on their own as the
 * Welcome screen, and inside the workspace when folders are open but no
 * tab is — so an opened folder shows its tree next to the ways to open a
 * file, instead of an empty pane.
 */
export const WelcomeContent: React.FC<WelcomeContentProps> = ({ onFileSelect, onBrowse, onOpenFolder, onOpenSample }) => {
    return (
        <div className="max-w-4xl mx-auto">
            <DropZone onFileSelect={onFileSelect} onBrowse={onBrowse} onOpenFolder={onOpenFolder} onOpenSample={onOpenSample} />
            <RecentFilesList onFileSelect={onFileSelect} />
            <FeatureHighlights />
        </div>
    );
};

interface WelcomeProps extends WelcomeContentProps {
    onOpenSettings: () => void;
}

export const Welcome: React.FC<WelcomeProps> = ({ onFileSelect, onBrowse, onOpenFolder, onOpenSample, onOpenSettings }) => {
    return (
        <div className="h-screen flex flex-col bg-slate-50 dark:bg-gray-900">
            <WelcomeHeader onBrowse={onBrowse} onOpenSettings={onOpenSettings} />
            <div className="flex-1 overflow-auto p-8">
                <WelcomeContent onFileSelect={onFileSelect} onBrowse={onBrowse} onOpenFolder={onOpenFolder} onOpenSample={onOpenSample} />
            </div>
        </div>
    );
};
