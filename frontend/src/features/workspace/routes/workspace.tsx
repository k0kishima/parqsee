import { useWorkspace } from '../../../contexts/WorkspaceContext';
import { FileExplorer } from '../../file-explorer';
import { TabBar } from '../../layout';
import { TabContent } from '../../file-viewer';
import { WelcomeContent } from '../../welcome';
import { Header } from '../components/header';
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
        closeTab,
        selectTab,
        toggleSidebar,
        toggleSettings,
        setTabState,
        openFileDialog,
        openFolderDialog,
        removeWorkspaceRoot,
    } = useWorkspace();

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
                {/* Header with toggle button */}
                <Header
                    isSidebarOpen={isSidebarOpen}
                    onToggleSidebar={toggleSidebar}
                    onOpenFile={openFileDialog}
                    onOpenFolder={openFolderDialog}
                    onOpenSettings={() => toggleSettings(true)}
                />

                {tabs.length === 0 ? (
                    // Folders are open but no file is: the ways to open one,
                    // next to the tree.
                    <div className="flex-1 overflow-auto p-8 bg-slate-50 dark:bg-gray-900">
                        <WelcomeContent
                            onFileSelect={openParquetFile}
                            onBrowse={openFileDialog}
                            onOpenFolder={openFolderDialog}
                        />
                    </div>
                ) : (
                    <>
                        {/* Tab Bar */}
                        <TabBar
                            tabs={tabs}
                            activeTabId={activeTabId}
                            onTabSelect={selectTab}
                            onTabClose={closeTab}
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
