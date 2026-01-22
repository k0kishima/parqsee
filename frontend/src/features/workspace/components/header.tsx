import { Menu } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface HeaderProps {
    isSidebarOpen: boolean;
    onToggleSidebar: () => void;
    effectiveTheme: string;
}

export const Header = ({ isSidebarOpen, onToggleSidebar, effectiveTheme }: HeaderProps) => {
    const { t } = useTranslation();
    return (
        <div className={`px-2 py-2 flex items-center border-b ${effectiveTheme === 'dark'
            ? 'bg-gray-800 border-gray-700'
            : 'bg-white border-gray-200'
            }`}>
            <button
                onClick={onToggleSidebar}
                className={`p-2 rounded-md transition-colors ${effectiveTheme === 'dark'
                    ? 'text-gray-300 hover:bg-gray-700'
                    : 'text-gray-600 hover:bg-gray-100'
                    }`}
                title={isSidebarOpen ? t('common.hideSidebar') : t('common.showSidebar')}
            >
                <Menu className="w-5 h-5" />
            </button>
            <span className={`ml-3 text-sm ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                }`}>{t('common.fileExplorer')}</span>
        </div>
    );
};
