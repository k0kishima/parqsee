import { useTranslation } from 'react-i18next';
import { SidebarToggle, HeaderActions, TOP_ROW_HEIGHT } from '../../layout';

interface HeaderProps {
    isSidebarOpen: boolean;
    onToggleSidebar: () => void;
    onOpenFile: () => void;
    onOpenFolder: () => void;
    onOpenSettings: () => void;
}

/**
 * The top row while no tab is open. With tabs, the tab bar is the top row
 * and carries the same controls at the same ends (see `TabBar`).
 */
export const Header = ({ isSidebarOpen, onToggleSidebar, onOpenFile, onOpenFolder, onOpenSettings }: HeaderProps) => {
    const { t } = useTranslation();
    return (
        <div className={`px-2 flex items-center border-b bg-white border-gray-200 dark:bg-gray-800 dark:border-gray-700 ${TOP_ROW_HEIGHT}`}>
            <SidebarToggle isOpen={isSidebarOpen} onToggle={onToggleSidebar} />
            {/* The app name, not a label for what is below: with tabs this
                spot is the tab strip, and the sidebar carries its own
                "File Explorer" heading. Matches the Welcome screen's header. */}
            <div className="ml-2 flex items-center gap-2">
                <img src="/logo.png" alt="" className="w-5 h-5 rounded" />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('common.appName')}</span>
            </div>
            <div className="ml-auto">
                <HeaderActions onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onOpenSettings={onOpenSettings} />
            </div>
        </div>
    );
};
