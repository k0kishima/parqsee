import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ChevronDown, Folder, FileText, File, Search, X } from 'lucide-react';
import { listDirectory, FileEntry } from '../api';
import { ContextMenu } from '../components/context-menu';
import { BreadcrumbNav } from '../components/breadcrumb-nav';

interface FileExplorerProps {
  currentPath?: string;
  onFileSelect: (path: string) => void;
  className?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: FileEntry;
}

export const FileExplorer: React.FC<FileExplorerProps> = ({ currentPath, onFileSelect, className }) => {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [currentDir, setCurrentDir] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (currentPath) {
      const dir = currentPath.substring(0, currentPath.lastIndexOf('/'));
      if (dir) {
        setCurrentDir(dir);
        loadDirectory(dir);
        setSelectedFile(currentPath);
      }
    }
  }, [currentPath]);

  const loadDirectory = async (path: string) => {
    try {
      const result = await listDirectory(path);
      setEntries(result);
    } catch (error) {
      console.error('Failed to load directory:', error);
    }
  };

  const toggleDirectory = (entry: FileEntry) => {
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(entry.path)) {
      newExpanded.delete(entry.path);
    } else {
      newExpanded.add(entry.path);
      loadSubDirectory(entry.path);
    }
    setExpandedDirs(newExpanded);
  };

  const loadSubDirectory = async (parentPath: string) => {
    try {
      const result = await listDirectory(parentPath);
      setEntries(prev => prev.map(entry =>
        entry.path === parentPath
          ? { ...entry, children: result }
          : entry
      ));
    } catch (error) {
      console.error('Failed to load sub-directory:', error);
    }
  };

  const handleFileClick = (entry: FileEntry) => {
    if (entry.is_directory) {
      toggleDirectory(entry);
    } else if (entry.is_parquet) {
      setSelectedFile(entry.path);
      onFileSelect(entry.path);
    }
  };

  const navigateToDirectory = useCallback((path: string) => {
    setCurrentDir(path);
    setExpandedDirs(new Set());
    setSearchQuery('');
    loadDirectory(path);
  }, [loadDirectory]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    const containerRect = containerRef.current?.getBoundingClientRect();
    const x = e.clientX - (containerRect?.left ?? 0);
    const y = e.clientY - (containerRect?.top ?? 0);
    setContextMenu({ x, y, entry });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const formatFileSize = (size?: number) => {
    if (!size) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let formattedSize = size;
    while (formattedSize >= 1024 && i < units.length - 1) {
      formattedSize /= 1024;
      i++;
    }
    return `${formattedSize.toFixed(1)} ${units[i]}`;
  };

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const query = searchQuery.toLowerCase();
    return entries.filter(entry => entry.name.toLowerCase().includes(query));
  }, [entries, searchQuery]);

  const renderEntry = (entry: FileEntry, level: number = 0) => {
    const isExpanded = expandedDirs.has(entry.path);
    const isSelected = selectedFile === entry.path;
    const isDisabled = !entry.is_directory && !entry.is_parquet;

    return (
      <div key={entry.path}>
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
          onClick={() => handleFileClick(entry)}
          onContextMenu={(e) => handleContextMenu(e, entry)}
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
            {entry.children.map(child => renderEntry(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className={`relative bg-primary border-primary border-r overflow-y-auto ${className}`}
    >
      <div className="p-3 border-b border-primary">
        <h3 className="text-sm font-semibold text-secondary">{t('common.fileExplorer')}</h3>
        <BreadcrumbNav currentDir={currentDir} onNavigate={navigateToDirectory} />
      </div>
      {/* Search box */}
      <div className="px-2 py-2 border-b border-primary">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tertiary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('fileExplorer.searchPlaceholder')}
            className="w-full pl-7 pr-7 py-1 text-xs rounded border border-secondary bg-primary text-primary placeholder:text-tertiary focus:border-blue-500 outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-tertiary text-tertiary"
              title={t('fileExplorer.clearSearch')}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
      <div className="py-1">
        {filteredEntries.map(entry => renderEntry(entry))}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={contextMenu.entry}
          onClose={closeContextMenu}
          onFileSelect={onFileSelect}
        />
      )}
    </div>
  );
};
