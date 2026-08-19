import React from 'react';
import { ChevronRight, ChevronDown, Folder, FileText, File } from 'lucide-react';
import { FileEntry } from '../api';
import { formatFileSize } from '../../../lib/format';

interface ExplorerEntryProps {
  entry: FileEntry;
  level: number;
  selectedFile: string | null;
  /** Set of expanded directory paths. Stable across selection changes. */
  expandedDirs: Set<string>;
  onEntryClick: (entry: FileEntry) => void;
  onEntryContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
}

/**
 * One row of the explorer tree (and, when expanded, its children).
 *
 * Memoized so that a tab switch — which only moves the selection highlight —
 * re-renders the two affected rows instead of the whole listing; with large
 * directories the full re-render was a visible part of the switch.
 */
export const ExplorerEntry: React.FC<ExplorerEntryProps> = React.memo(function ExplorerEntry({
  entry,
  level,
  selectedFile,
  expandedDirs,
  onEntryClick,
  onEntryContextMenu,
}) {
  const isExpanded = expandedDirs.has(entry.path);
  const isSelected = selectedFile === entry.path;
  const isDisabled = !entry.is_directory && !entry.is_parquet;

  return (
    <div>
      <div
        className={`
          flex items-center px-2 py-1
          ${isDisabled
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer'
          }
          ${isSelected
            ? 'bg-selected'
            : isDisabled
              ? ''
              : 'hover:bg-tertiary'
          }
        `}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => onEntryClick(entry)}
        onContextMenu={(e) => onEntryContextMenu(e, entry)}
      >
        {entry.is_directory ? (
          <>
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 mr-1 text-tertiary" />
            ) : (
              <ChevronRight className="w-4 h-4 mr-1 text-tertiary" />
            )}
            <Folder className="w-4 h-4 mr-2 text-blue-500" />
          </>
        ) : (
          <>
            <div className="w-4 h-4 mr-1" />
            {entry.is_parquet ? (
              <FileText className="w-4 h-4 mr-2 text-green-500" />
            ) : (
              <File className="w-4 h-4 mr-2 text-tertiary" />
            )}
          </>
        )}
        <span className={`flex-1 text-sm truncate ${isDisabled ? 'text-tertiary' : 'text-primary'}`}>
          {entry.name}
        </span>
        {!entry.is_directory && (
          <span className="text-xs ml-2 text-tertiary">
            {formatFileSize(entry.size)}
          </span>
        )}
      </div>
      {entry.is_directory && isExpanded && entry.children && (
        <div>
          {entry.children.map(child => (
            <ExplorerEntry
              key={child.path}
              entry={child}
              level={level + 1}
              selectedFile={selectedFile}
              expandedDirs={expandedDirs}
              onEntryClick={onEntryClick}
              onEntryContextMenu={onEntryContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  if (prev.entry !== next.entry || prev.level !== next.level) return false;
  if (prev.expandedDirs !== next.expandedDirs) return false;
  if (prev.onEntryClick !== next.onEntryClick || prev.onEntryContextMenu !== next.onEntryContextMenu) return false;
  // Selection only matters to this row (and its subtree, when it has one).
  const selectionTouchesRow = (file: string | null) =>
    file !== null && (file === prev.entry.path || (prev.entry.is_directory && file.startsWith(prev.entry.path + '/')));
  if (prev.selectedFile !== next.selectedFile) {
    return !selectionTouchesRow(prev.selectedFile) && !selectionTouchesRow(next.selectedFile);
  }
  return true;
});
