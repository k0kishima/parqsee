import { useTranslation } from 'react-i18next';
import { SidebarToggle, HeaderActions, TOP_ROW_HEIGHT } from './header-controls';

interface AppHeaderProps {
    isSidebarOpen: boolean;
    /**
     * Absent on the Welcome screen, where there is no explorer to show yet:
     * the toggle is then disabled rather than gone, so the app name and the
     * actions sit where they will once a folder or a file makes this the
     * workspace.
     */
    onToggleSidebar?: () => void;
    onOpenFile: () => void;
    onOpenFolder: () => void;
    onOpenRecentFile: (path: string) => void;
    onOpenSettings: () => void;
}

/**
 * The window's top row while no tab is open — on the Welcome screen and in
 * the workspace alike. With tabs, the tab bar is the row and carries the
 * same controls at the same ends (see `TabBar`).
 */
export const AppHeader = ({ isSidebarOpen, onToggleSidebar, onOpenFile, onOpenFolder, onOpenRecentFile, onOpenSettings }: AppHeaderProps) => {
    const { t } = useTranslation();
    return (
        <div className={`px-2 flex items-center border-b bg-white border-gray-200 dark:bg-gray-800 dark:border-gray-700 ${TOP_ROW_HEIGHT}`}>
            <SidebarToggle isOpen={isSidebarOpen} onToggle={onToggleSidebar} />
            {/* The app name, not a label for what is below: with tabs this
                spot is the tab strip, and the sidebar carries its own
                "File Explorer" heading. */}
            <div className="ml-2 flex items-center gap-2">
                <img src="/logo.png" alt="" className="w-5 h-5 rounded" />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('common.appName')}</span>
            </div>
            <div className="ml-auto">
                <HeaderActions onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onOpenRecentFile={onOpenRecentFile} onOpenSettings={onOpenSettings} />
            </div>
        </div>
    );
};
