import { useWorkspace } from '../contexts/WorkspaceContext';
import { useLicense } from '../contexts/LicenseContext';
import { Workspace, RestoreNotice } from '../features/workspace';
import { Welcome } from '../features/welcome';
import { SettingsModal } from '../features/settings';
import { UpgradePrompt } from '../features/license';

export const AppRouter = () => {
    const {
        tabs, roots, isSettingsOpen, toggleSettings, openParquetFile, openFileDialog, openFolderDialog,
        restoreNotice, dismissRestoreNotice,
    } = useWorkspace();
    const { upgradeOpen, showUpgrade } = useLicense();

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

            {/* Over either screen: the free tier's limit was hit, or Upgrade was clicked. */}
            {upgradeOpen && <UpgradePrompt />}

            {/* Shown over either screen: the whole session may have failed to come back. */}
            {restoreNotice && (
                <RestoreNotice
                    skipped={restoreNotice.skipped}
                    capped={restoreNotice.capped}
                    onDismiss={dismissRestoreNotice}
                    onUpgrade={showUpgrade}
                />
            )}
        </>
    );
};
