import React from 'react';
import { AppHeader } from '../../layout';
import { DropZone } from '../components/drop-zone';
import { RecentFilesList } from '../components/recent-files-list';
import { FeatureHighlights } from '../components/feature-highlights';

interface WelcomeContentProps {
    onFileSelect: (path: string) => void;
    onBrowse: () => void;
    onOpenFolder: () => void;
    onOpenSample: () => void;
    onShowShortcuts: () => void;
}

/**
 * The drop zone, recent files and feature cards. Shown on their own as the
 * Welcome screen, and inside the workspace when folders are open but no
 * tab is — so an opened folder shows its tree next to the ways to open a
 * file, instead of an empty pane.
 */
export const WelcomeContent: React.FC<WelcomeContentProps> = ({ onFileSelect, onBrowse, onOpenFolder, onOpenSample, onShowShortcuts }) => {
    return (
        <div className="max-w-4xl mx-auto">
            <DropZone onFileSelect={onFileSelect} onBrowse={onBrowse} onOpenFolder={onOpenFolder} onOpenSample={onOpenSample} />
            <RecentFilesList onFileSelect={onFileSelect} />
            <FeatureHighlights onShowShortcuts={onShowShortcuts} />
        </div>
    );
};

interface WelcomeProps extends WelcomeContentProps {
    onOpenSettings: () => void;
}

export const Welcome: React.FC<WelcomeProps> = ({ onFileSelect, onBrowse, onOpenFolder, onOpenSample, onOpenSettings, onShowShortcuts }) => {
    return (
        <div className="h-screen flex flex-col bg-slate-50 dark:bg-gray-900">
            {/* The workspace's top row, so opening the first folder or file
                does not swap one header for a taller one with a different
                set of controls. There is no explorer yet, so no toggle. */}
            <AppHeader
                isSidebarOpen={false}
                onOpenFile={onBrowse}
                onOpenFolder={onOpenFolder}
                onOpenRecentFile={onFileSelect}
                onOpenSettings={onOpenSettings}
            />
            <div className="flex-1 overflow-auto p-8">
                <WelcomeContent onFileSelect={onFileSelect} onBrowse={onBrowse} onOpenFolder={onOpenFolder} onOpenSample={onOpenSample} onShowShortcuts={onShowShortcuts} />
            </div>
        </div>
    );
};
