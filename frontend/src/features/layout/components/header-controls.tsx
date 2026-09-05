import { Menu, File, FolderOpen, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FreeBadge } from '../../license';

const iconButton = 'p-2 rounded-md transition-colors text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700';

/**
 * The height of the window's top row — the header while no tab is open, the
 * tab bar once one is. Both must be exactly this tall, or opening the first
 * file (and closing the last) moves the sidebar toggle at one end and these
 * actions at the other, and shifts the whole panel below.
 *
 * The value is the tab's own box: `text-sm` on `py-2` inside a 1px border,
 * with the active tab offset a further 1px. That is what the tab bar used
 * to happen to measure; it is declared here so neither row can drift.
 */
export const TOP_ROW_HEIGHT = 'h-[38px]';

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
            title={`${isOpen ? t('common.hideSidebar') : t('common.showSidebar')} (⌘B)`}
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
