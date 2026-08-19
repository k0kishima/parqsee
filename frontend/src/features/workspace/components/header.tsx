import { Menu } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface HeaderProps {
    isSidebarOpen: boolean;
    onToggleSidebar: () => void;
}

export const Header = ({ isSidebarOpen, onToggleSidebar }: HeaderProps) => {
    const { t } = useTranslation();
    return (
        <div className="px-2 py-2 flex items-center border-b bg-white border-gray-200 dark:bg-gray-800 dark:border-gray-700">
            <button
                onClick={onToggleSidebar}
                className="p-2 rounded-md transition-colors text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                title={isSidebarOpen ? t('common.hideSidebar') : t('common.showSidebar')}
            >
                <Menu className="w-5 h-5" />
            </button>
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">{t('common.fileExplorer')}</span>
        </div>
    );
};