import { useWorkspace } from '../contexts/WorkspaceContext';
import { useLicense } from '../contexts/LicenseContext';
import { Workspace, RestoreNotice } from '../features/workspace';
import { Welcome } from '../features/welcome';
import { SettingsModal } from '../features/settings';
import { LicenseGate } from '../features/license';

export const AppRouter = () => {
    const {
        tabs, roots, isSettingsOpen, toggleSettings, openParquetFile, openFileDialog, openFolderDialog,
        restoreNotice, dismissRestoreNotice,
    } = useWorkspace();
    const { screen } = useLicense();

    // Locked (before the trial, or after it without the purchase): the
    // Welcome screen stays underneath so it is obvious what the app is,
    // and the gate is the only thing to interact with. The tabs, if any,
    // stay in the workspace context and come back once it unlocks.
    const locked = screen === 'pretrial' || screen === 'paywall';

    return (
        <>
            {!locked && (tabs.length > 0 || roots.length > 0) ? (
                <Workspace />
            ) : (
                <Welcome
                    onFileSelect={openParquetFile}
                    onBrowse={openFileDialog}
                    onOpenFolder={openFolderDialog}
                    onOpenSettings={() => toggleSettings(true)}
                />
            )}

            {locked ? (
                <LicenseGate mode={screen} />
            ) : (
                <SettingsModal
                    isOpen={isSettingsOpen}
                    onClose={() => toggleSettings(false)}
                />
            )}

            {/* Shown over either screen: the whole session may have failed to come back. */}
            {restoreNotice && (
                <RestoreNotice skipped={restoreNotice.skipped} onDismiss={dismissRestoreNotice} />
            )}
        </>
    );
};
