
import React from 'react';
import { SettingsProvider } from '../contexts/SettingsContext';
import { LicenseProvider } from '../contexts/LicenseContext';
import { RecentFilesProvider } from '../contexts/RecentFilesContext';
import { WorkspaceProvider } from '../contexts/WorkspaceContext';

interface AppProviderProps {
    children: React.ReactNode;
}

export const AppProvider = ({ children }: AppProviderProps) => {
    return (
        <SettingsProvider>
            {/* Renders nothing until the purchase state is known: the
                workspace needs the free tier's tab limit when it restores
                the session at mount. */}
            <LicenseProvider>
                <RecentFilesProvider>
                    <WorkspaceProvider>
                        {children}
                    </WorkspaceProvider>
                </RecentFilesProvider>
            </LicenseProvider>
        </SettingsProvider>
    );
};
