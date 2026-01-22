import React from 'react';
import { X, FileText } from 'lucide-react';
import { useSettings } from '../../../contexts/SettingsContext';

interface Tab {
  id: string;
  path: string;
  name: string;
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
}

const TabBarComponent: React.FC<TabBarProps> = ({ tabs, activeTabId, onTabSelect, onTabClose }) => {
  const { effectiveTheme } = useSettings();

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation(); // Prevent tab selection when closing
    onTabClose(tabId);
  };

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className={`flex items-end border-b ${effectiveTheme === 'dark' ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-200'
      }`}>
      <div className="flex overflow-x-auto scrollbar-thin">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onTabSelect(tab.id)}
              className={`
                group flex items-center gap-2 px-3 py-2 border-t border-l border-r cursor-pointer
                min-w-[120px] max-w-[200px] transition-all
                ${isActive
                  ? effectiveTheme === 'dark'
                    ? 'bg-gray-800 border-gray-600 border-b-gray-800'
                    : 'bg-white border-gray-200 border-b-white'
                  : effectiveTheme === 'dark'
                    ? 'bg-gray-800/50 border-gray-700 hover:bg-gray-800/70'
                    : 'bg-gray-100 border-gray-200 hover:bg-gray-50'
                }
                ${isActive ? 'relative top-[1px]' : ''}
              `}
            >
              <FileText className={`w-4 h-4 flex-shrink-0 ${isActive
                ? 'text-green-500'
                : effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                }`} />

              <span className={`
                flex-1 text-sm truncate
                ${isActive
                  ? effectiveTheme === 'dark' ? 'text-gray-100 font-medium' : 'text-gray-900 font-medium'
                  : effectiveTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
                }
              `} title={tab.path}>
                {tab.name}
              </span>

              <button
                onClick={(e) => handleCloseTab(e, tab.id)}
                className={`
                  opacity-0 group-hover:opacity-100 transition-opacity
                  p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600
                  ${tabs.length === 1 ? 'hidden' : ''}
                `}
                title="Close tab"
              >
                <X className={`w-3 h-3 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                  }`} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Memoize TabBar to prevent unnecessary re-renders
export const TabBar = React.memo(TabBarComponent, (prevProps, nextProps) => {
  // Deep comparison for tabs array
  if (prevProps.tabs.length !== nextProps.tabs.length) return false;
  if (prevProps.activeTabId !== nextProps.activeTabId) return false;

  // Check if tabs content changed
  for (let i = 0; i < prevProps.tabs.length; i++) {
    if (prevProps.tabs[i].id !== nextProps.tabs[i].id ||
      prevProps.tabs[i].name !== nextProps.tabs[i].name) {
      return false;
    }
  }

  return true;
});