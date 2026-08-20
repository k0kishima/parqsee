

import { useWorkspace } from '../contexts/WorkspaceContext';
import { Workspace } from '../features/workspace';
import { Welcome } from '../features/welcome';
import { SettingsModal } from '../features/settings';

export const AppRouter = () => {
    const { currentFile, tabs, isSettingsOpen, toggleSettings, openParquetFile, openFileDialog } = useWorkspace();

    return (
        <>
            {currentFile && tabs.length > 0 ? (
                <Workspace />
            ) : (
                <Welcome
                    onFileSelect={openParquetFile}
                    onBrowse={openFileDialog}
                    onOpenSettings={() => toggleSettings(true)}
                />
            )}

            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => toggleSettings(false)}
            />
        </>
    );
};
