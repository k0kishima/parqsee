import { Menu, File, FolderOpen, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FreeBadge } from '../../license';

const iconButton = 'p-2 rounded-md transition-colors text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700';

interface SidebarToggleProps {
    isOpen: boolean;
    onToggle: () => void;
}

/** The ≡ button at the left end of the top row: shows / hides the explorer. */
export const SidebarToggle = ({ isOpen, onToggle }: SidebarToggleProps) => {
    const { t } = useTranslation();
    return (
        <button
            onClick={onToggle}
            className={iconButton}
            title={isOpen ? t('common.hideSidebar') : t('common.showSidebar')}
        >
            <Menu className="w-5 h-5" />
        </button>
    );
};

interface HeaderActionsProps {
    onOpenFile: () => void;
    onOpenFolder: () => void;
    onOpenSettings: () => void;
}

/**
 * The right end of the top row: the Free badge and Open File / Open Folder /
 * Settings. The same group whether the row is the header (no tabs) or the
 * tab bar, so the buttons never move.
 */
export const HeaderActions = ({ onOpenFile, onOpenFolder, onOpenSettings }: HeaderActionsProps) => {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1">
            <FreeBadge />
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
    );
};
