import { useCallback } from 'react';
import { useWorkspace } from '../../../contexts/WorkspaceContext';
import { FileExplorer } from '../../file-explorer';
import { AppHeader, TabBar } from '../../layout';
import { TabContent } from '../../file-viewer';
import { WelcomeContent } from '../../welcome';
import { Sidebar } from '../components/sidebar';

export const Workspace = () => {
    const {
        currentFile,
        tabs,
        activeTabId,
        isSidebarOpen,
        isPending,
        tabStates,
        roots,
        openParquetFile,
        openSampleFile,
        closeTab,
        closeTabs,
        selectTab,
        toggleSidebar,
        toggleSettings,
        setTabState,
        openFileDialog,
        openFolderDialog,
        removeWorkspaceRoot,
    } = useWorkspace();
    const openSettings = useCallback(() => toggleSettings(true), [toggleSettings]);

    return (
        <div className="h-screen flex">
            {/* Sidebar */}
            <Sidebar isOpen={isSidebarOpen}>
                <FileExplorer
                    roots={roots}
                    currentPath={currentFile}
                    onFileSelect={openParquetFile}
                    onOpenFolder={openFolderDialog}
                    onRemoveRoot={removeWorkspaceRoot}
                    className="h-full"
                />
            </Sidebar>

            {/* Main Content */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {tabs.length === 0 ? (
                    // Folders are open but no file is: the ways to open one,
                    // next to the tree. The header is the top row only here;
                    // with tabs, the tab bar carries its controls.
                    <>
                    <AppHeader
                        isSidebarOpen={isSidebarOpen}
                        onToggleSidebar={toggleSidebar}
                        onOpenFile={openFileDialog}
                        onOpenFolder={openFolderDialog}
                        onOpenSettings={openSettings}
                    />
                    <div className="flex-1 overflow-auto p-8 bg-slate-50 dark:bg-gray-900">
                        <WelcomeContent
                            onFileSelect={openParquetFile}
                            onBrowse={openFileDialog}
                            onOpenFolder={openFolderDialog}
                            onOpenSample={openSampleFile}
                        />
                    </div>
                    </>
                ) : (
                    <>
                        {/* Tab Bar: the top row, with the header's controls at its ends */}
                        <TabBar
                            tabs={tabs}
                            activeTabId={activeTabId}
                            onTabSelect={selectTab}
                            onTabClose={closeTab}
                            onTabsClose={closeTabs}
                            isSidebarOpen={isSidebarOpen}
                            onToggleSidebar={toggleSidebar}
                            onOpenFile={openFileDialog}
                            onOpenFolder={openFolderDialog}
                            onOpenSettings={openSettings}
                        />

                        {/* Only render the active tab for better performance */}
                        <div className="flex-1 overflow-hidden relative">
                            {tabs.map(tab => (
                                <TabContent
                                    key={tab.id}
                                    tab={tab}
                                    isActive={tab.id === activeTabId}
                                    onClose={() => closeTab(tab.id)}
                                    savedState={tabStates[tab.id]}
                                    onStateChange={(state) => {
                                        setTabState(tab.id, state);
                                    }}
                                />
                            ))}
                            {/* Loading indicator for tab transitions */}
                            {isPending && (
                                <div className="absolute top-0 left-0 right-0 h-1 bg-blue-500 animate-pulse" />
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
