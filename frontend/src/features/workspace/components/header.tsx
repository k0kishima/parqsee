import { Menu, File, FolderOpen, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface HeaderProps {
    isSidebarOpen: boolean;
    onToggleSidebar: () => void;
    onOpenFile: () => void;
    onOpenFolder: () => void;
    onOpenSettings: () => void;
}

const iconButton = 'p-2 rounded-md transition-colors text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700';

export const Header = ({ isSidebarOpen, onToggleSidebar, onOpenFile, onOpenFolder, onOpenSettings }: HeaderProps) => {
    const { t } = useTranslation();
    return (
        <div className="px-2 py-2 flex items-center border-b bg-white border-gray-200 dark:bg-gray-800 dark:border-gray-700">
            <button
                onClick={onToggleSidebar}
                className={iconButton}
                title={isSidebarOpen ? t('common.hideSidebar') : t('common.showSidebar')}
            >
                <Menu className="w-5 h-5" />
            </button>
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">{t('common.fileExplorer')}</span>
            <div className="ml-auto flex items-center gap-1">
                <button onClick={onOpenFile} className={iconButton} title={`${t('common.openFile')} (⌘O)`}>
                    <File className="w-5 h-5" />
                </button>
                <button onClick={onOpenFolder} className={iconButton} title={`${t('common.openFolder')} (⌘⇧O)`}>
                    <FolderOpen className="w-5 h-5" />
                </button>
                <button onClick={onOpenSettings} className={iconButton} title={`${t('settings.title')} (⌘,)`}>
                    <Settings className="w-5 h-5" />
                </button>
            </div>
        </div>
    );
};
