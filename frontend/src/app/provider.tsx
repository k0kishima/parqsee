
import React from 'react';
import { SettingsProvider } from '../contexts/SettingsContext';
import { RecentFilesProvider } from '../contexts/RecentFilesContext';
import { WorkspaceProvider } from '../contexts/WorkspaceContext';

interface AppProviderProps {
    children: React.ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => {
    return (
        <SettingsProvider>
            <RecentFilesProvider>
                <WorkspaceProvider>
                    {children}
                </WorkspaceProvider>
            </RecentFilesProvider>
        </SettingsProvider>
    );
};
