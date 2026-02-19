
import { createContext, useContext, useState, useCallback, useEffect, useTransition, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useRecentFiles } from './RecentFilesContext';
import { isTauri } from '../lib/tauri';

import { openParquetFile as apiOpenParquetFile, checkFileExists, getFileInfo, evictCache } from '../features/file-viewer/api';
import { TabState } from '../features/file-viewer';

interface Tab {
    id: string;
    path: string;
    name: string;
}

interface WorkspaceContextType {
    currentFile: string | null;
    tabs: Tab[];
    activeTabId: string | null;
    isSidebarOpen: boolean;
    isSettingsOpen: boolean;
    isPending: boolean;
    tabStates: Record<string, TabState>;
    openParquetFile: (path: string) => Promise<void>;
    closeTab: (tabId: string) => void;
    selectTab: (tabId: string) => void;
    toggleSidebar: () => void;
    toggleSettings: (isOpen: boolean) => void;
    setTabState: (tabId: string, state: TabState) => void;
    activeTab: Tab | undefined;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const [currentFile, setCurrentFile] = useState<string | null>(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [tabStates, setTabStates] = useState<Record<string, TabState>>({});
    const [isPending, startTransition] = useTransition();
    const { addRecentFile, removeRecentFile } = useRecentFiles();


    const handleTabSelect = useCallback((tabId: string) => {
        const tab = tabs.find(t => t.id === tabId);
        if (tab) {
            requestAnimationFrame(() => {
                startTransition(() => {
                    setActiveTabId(tabId);
                    setCurrentFile(tab.path);
                });
            });
        }
    }, [tabs]);

    const handleTabClose = useCallback((tabId: string) => {
        const closedTab = tabs.find(t => t.id === tabId);
        const tabIndex = tabs.findIndex(t => t.id === tabId);
        const newTabs = tabs.filter(t => t.id !== tabId);
        setTabs(newTabs);

        // Clean up state for closed tab
        const newTabStates = { ...tabStates };
        delete newTabStates[tabId];
        setTabStates(newTabStates);

        // Evict backend cache if no other tab uses the same file
        if (closedTab && !newTabs.some(t => t.path === closedTab.path)) {
            evictCache(closedTab.path).catch(err => console.error('Failed to evict cache:', err));
        }

        if (activeTabId === tabId) {
            if (newTabs.length > 0) {
                const newIndex = Math.min(tabIndex, newTabs.length - 1);
                setActiveTabId(newTabs[newIndex].id);
                setCurrentFile(newTabs[newIndex].path);
            } else {
                setActiveTabId(null);
                setCurrentFile(null);
            }
        }
    }, [tabs, activeTabId, tabStates]);

    const openParquetFile = useCallback(async (path: string) => {
        try {
            if (isTauri()) {
                const fileExists = await checkFileExists(path);
                if (!fileExists) {
                    removeRecentFile(path);
                    alert(`File not found: ${path}`);
                    return;
                }

                await apiOpenParquetFile(path);
                const fileInfo = await getFileInfo(path);

                addRecentFile({
                    path: fileInfo.path,
                    name: fileInfo.name,
                    lastAccessed: new Date().toLocaleString(),
                    size: fileInfo.size
                });

                const existingTab = tabs.find(tab => tab.path === path);
                if (existingTab) {
                    setActiveTabId(existingTab.id);
                    setCurrentFile(path);
                } else {
                    const newTab: Tab = {
                        id: Date.now().toString(),
                        path: fileInfo.path,
                        name: fileInfo.name
                    };
                    setTabs(prev => [...prev, newTab]);
                    setActiveTabId(newTab.id);
                    setCurrentFile(path);
                }
            } else {
                console.log("Running in browser, simulating file open:", path);
                setCurrentFile(path);
            }
        } catch (error) {
            console.error("Failed to open parquet file:", error);
            alert(`Failed to open file: ${error}`);
        }
    }, [tabs, addRecentFile, removeRecentFile]);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
                e.preventDefault();
                if (activeTabId) {
                    handleTabClose(activeTabId);
                }
            } else if ((e.metaKey && e.shiftKey && e.key === '[') || (e.metaKey && e.altKey && e.key === 'ArrowLeft')) {
                e.preventDefault();
                const currentIndex = tabs.findIndex(t => t.id === activeTabId);
                if (currentIndex > 0) {
                    handleTabSelect(tabs[currentIndex - 1].id);
                } else if (tabs.length > 0) {
                    handleTabSelect(tabs[tabs.length - 1].id);
                }
            } else if ((e.metaKey && e.shiftKey && e.key === ']') || (e.metaKey && e.altKey && e.key === 'ArrowRight')) {
                e.preventDefault();
                const currentIndex = tabs.findIndex(t => t.id === activeTabId);
                if (currentIndex < tabs.length - 1) {
                    handleTabSelect(tabs[currentIndex + 1].id);
                } else if (tabs.length > 0) {
                    handleTabSelect(tabs[0].id);
                }
            } else if (e.metaKey && e.key >= '1' && e.key <= '9') {
                e.preventDefault();
                const tabIndex = parseInt(e.key) - 1;
                if (tabIndex < tabs.length) {
                    handleTabSelect(tabs[tabIndex].id);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeTabId, tabs, handleTabClose, handleTabSelect]);

    // File drop listener
    useEffect(() => {
        if (isTauri()) {
            const unlisten = listen('file-drop', async (event: any) => {
                const files = event.payload || [];
                if (files.length > 0) {
                    const parquetFile = files.find((f: string) => f.endsWith('.parquet'));
                    if (parquetFile) {
                        openParquetFile(parquetFile);
                    } else {
                        alert('Please drop a .parquet file');
                    }
                }
            });

            return () => {
                unlisten.then(fn => fn());
            };
        }
    }, [openParquetFile]);

    const activeTab = tabs.find(t => t.id === activeTabId);

    const value = {
        currentFile,
        tabs,
        activeTabId,
        isSidebarOpen,
        isSettingsOpen,
        isPending,
        tabStates,
        openParquetFile,
        closeTab: handleTabClose,
        selectTab: handleTabSelect,
        toggleSidebar: () => setIsSidebarOpen(prev => !prev),
        toggleSettings: setIsSettingsOpen,
        setTabState: (tabId: string, state: TabState) => setTabStates(prev => ({ ...prev, [tabId]: state })),
        activeTab
    };

    return (
        <WorkspaceContext.Provider value={value}>
            {children}
        </WorkspaceContext.Provider>
    );
}

export function useWorkspace() {
    const context = useContext(WorkspaceContext);
    if (context === undefined) {
        throw new Error('useWorkspace must be used within a WorkspaceProvider');
    }
    return context;
}
