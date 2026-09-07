import { useWorkspace } from '../contexts/WorkspaceContext';
import { useLicense } from '../contexts/LicenseContext';
import { Workspace, RestoreNotice } from '../features/workspace';
import { Welcome } from '../features/welcome';
import { SettingsModal } from '../features/settings';
import { UpgradePrompt } from '../features/license';
import { ShortcutSheet } from '../features/help';

export const AppRouter = () => {
    const {
        tabs, roots, isReady, isSettingsOpen, toggleSettings, isShortcutsOpen, toggleShortcuts,
        openParquetFile, openSampleFile, openFileDialog, openFolderDialog,
        restoreNotice, dismissRestoreNotice,
    } = useWorkspace();
    // From Settings the sheet takes the dialog's place, so one Escape
    // closes one thing.
    const showShortcuts = () => {
        toggleSettings(false);
        toggleShortcuts(true);
    };
    const { upgradeOpen, showUpgrade } = useLicense();

    // The workspace roots and the last session's tabs each arrive from their
    // own command, so painting before both are in shows the Welcome screen,
    // then the workspace, then the tabs — a window that rearranges itself
    // twice at every launch without the user having touched anything. Wait
    // for them and paint the layout once. What is waited on is two metadata
    // reads plus reopening the restored files, so this is the window's own
    // surface and nothing else; a spinner would only flash.
    if (!isReady) {
        return <div className="h-screen bg-slate-50 dark:bg-gray-900" />;
    }

    return (
        <>
            {tabs.length > 0 || roots.length > 0 ? (
                <Workspace />
            ) : (
                <Welcome
                    onFileSelect={openParquetFile}
                    onBrowse={openFileDialog}
                    onOpenFolder={openFolderDialog}
                    onOpenSample={openSampleFile}
                    onOpenSettings={() => toggleSettings(true)}
                    onShowShortcuts={showShortcuts}
                />
            )}

            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => toggleSettings(false)}
                onShowShortcuts={showShortcuts}
            />

            {/* Over either screen and over Settings: ⌘/, Help › Keyboard Shortcuts. */}
            <ShortcutSheet isOpen={isShortcutsOpen} onClose={() => toggleShortcuts(false)} />

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
