import { useTranslation } from 'react-i18next';
import { SidebarToggle, HeaderActions } from '../../layout';

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
        <div className="px-2 py-2 flex items-center border-b bg-white border-gray-200 dark:bg-gray-800 dark:border-gray-700">
            <SidebarToggle isOpen={isSidebarOpen} onToggle={onToggleSidebar} />
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">{t('common.fileExplorer')}</span>
            <div className="ml-auto">
                <HeaderActions onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onOpenSettings={onOpenSettings} />
            </div>
        </div>
    );
};
