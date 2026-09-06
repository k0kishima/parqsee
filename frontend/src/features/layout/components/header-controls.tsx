import { useCallback, useState } from 'react';
import { Menu, File, FolderOpen, History, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FreeBadge } from '../../license';
// The component file, not the feature's index: the index re-exports the
// Welcome route, which renders `AppHeader` from here.
import { RecentFilesPopover } from '../../welcome/components/recent-files-popover';

const iconButtonBase = 'p-2 rounded-md transition-colors text-gray-600 dark:text-gray-300';
const iconButton = `${iconButtonBase} hover:bg-gray-100 dark:hover:bg-gray-700`;

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
    /** Absent where there is no explorer to toggle; see `AppHeader`. */
    onToggle?: () => void;
}

/** The ≡ button at the left end of the top row: shows / hides the explorer. */
export const SidebarToggle = ({ isOpen, onToggle }: SidebarToggleProps) => {
    const { t } = useTranslation();
    return (
        <button
            onClick={onToggle}
            disabled={!onToggle}
            className={onToggle ? iconButton : `${iconButtonBase} opacity-40 cursor-default`}
            title={onToggle
                ? `${isOpen ? t('common.hideSidebar') : t('common.showSidebar')} (⌘B)`
                : t('common.sidebarUnavailable')}
        >
            <Menu className="w-5 h-5" />
        </button>
    );
};

interface HeaderActionsProps {
    onOpenFile: () => void;
    onOpenFolder: () => void;
    /** Open a file picked in the Recent Files panel. */
    onOpenRecentFile: (path: string) => void;
    onOpenSettings: () => void;
}

/**
 * The right end of the top row: the Free badge and Open File / Open Folder /
 * Recent Files / Settings. The same group whether the row is the header (no
 * tabs) or the tab bar, so the buttons never move. Recent Files drops a
 * panel under its button — the Welcome screen's list is out of reach the
 * moment a tab is open.
 */
export const HeaderActions = ({ onOpenFile, onOpenFolder, onOpenRecentFile, onOpenSettings }: HeaderActionsProps) => {
    const { t } = useTranslation();
    const [isRecentOpen, setIsRecentOpen] = useState(false);
    const closeRecent = useCallback(() => setIsRecentOpen(false), []);
    return (
        <div className="flex items-center gap-1">
            <FreeBadge />
            <button onClick={onOpenFile} className={iconButton} title={`${t('common.openFile')} (⌘O)`}>
                <File className="w-5 h-5" />
            </button>
            <button onClick={onOpenFolder} className={iconButton} title={`${t('common.openFolder')} (⌘⇧O)`}>
                <FolderOpen className="w-5 h-5" />
            </button>
            {/* The wrapper anchors the panel; the panel treats a click on
                anything inside it (this button included) as not-outside. */}
            <div className="relative">
                <button
                    onClick={() => setIsRecentOpen(open => !open)}
                    className={`${iconButton} ${isRecentOpen ? 'bg-gray-100 dark:bg-gray-700' : ''}`}
                    title={t('common.recentFiles')}
                    aria-expanded={isRecentOpen}
                >
                    <History className="w-5 h-5" />
                </button>
                {isRecentOpen && <RecentFilesPopover onFileSelect={onOpenRecentFile} onClose={closeRecent} />}
            </div>
            <button onClick={onOpenSettings} className={iconButton} title={`${t('settings.title')} (⌘,)`}>
                <Settings className="w-5 h-5" />
            </button>
        </div>
    );
};
