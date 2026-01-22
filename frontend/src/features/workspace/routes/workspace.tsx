

import { useWorkspace } from '../../../contexts/WorkspaceContext';
import { useSettings } from '../../../contexts/SettingsContext';
import { FileExplorer } from '../../file-explorer';
import { TabBar } from '../../layout';
import { TabContent } from '../../file-viewer';
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
        openParquetFile,
        closeTab,
        selectTab,
        toggleSidebar,
        setTabState,

    } = useWorkspace();
    const { effectiveTheme } = useSettings();

    return (
        <div className="h-screen flex">
            {/* Sidebar */}
            <Sidebar isOpen={isSidebarOpen}>
                {currentFile && (
                    <FileExplorer
                        currentPath={currentFile}
                        onFileSelect={openParquetFile}
                        className="h-full"
                    />
                )}
            </Sidebar>

            {/* Main Content */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Header with toggle button */}
                <Header
                    isSidebarOpen={isSidebarOpen}
                    onToggleSidebar={toggleSidebar}
                    effectiveTheme={effectiveTheme}
                />

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
            </div>
        </div>
    );
};
