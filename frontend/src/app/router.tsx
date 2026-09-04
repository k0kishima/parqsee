

import { useWorkspace } from '../contexts/WorkspaceContext';
import { Workspace } from '../features/workspace';
import { Welcome } from '../features/welcome';
import { SettingsModal } from '../features/settings';

export const AppRouter = () => {
    const { tabs, roots, isSettingsOpen, toggleSettings, openParquetFile, openFileDialog, openFolderDialog } = useWorkspace();

    return (
        <>
            {tabs.length > 0 || roots.length > 0 ? (
                <Workspace />
            ) : (
                <Welcome
                    onFileSelect={openParquetFile}
                    onBrowse={openFileDialog}
                    onOpenFolder={openFolderDialog}
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
