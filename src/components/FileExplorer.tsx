import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, ChevronDown, Folder, FileText, File } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';

interface FileEntry {
  path: string;
  name: string;
  is_directory: boolean;
  is_parquet: boolean;
  size?: number;
  children?: FileEntry[];
}

interface FileExplorerProps {
  currentPath?: string;
  onFileSelect: (path: string) => void;
  className?: string;
}

const FileExplorer: React.FC<FileExplorerProps> = ({ currentPath, onFileSelect, className }) => {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [currentDir, setCurrentDir] = useState<string>('');
  const { effectiveTheme } = useSettings();

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
      const result = await invoke<FileEntry[]>('list_directory', { path });
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
      loadSubDirectory(entry);
    }
    setExpandedDirs(newExpanded);
  };

  const loadSubDirectory = async (parent: FileEntry) => {
    try {
      const result = await invoke<FileEntry[]>('list_directory', { path: parent.path });
      parent.children = result;
      setEntries([...entries]);
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
    // Non-parquet files do nothing when clicked
  };

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
              ? effectiveTheme === 'dark' ? 'bg-blue-900' : 'bg-blue-100'
              : isDisabled 
                ? '' 
                : effectiveTheme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-gray-100'
            }
          `}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={() => handleFileClick(entry)}
        >
          {entry.is_directory ? (
            <>
              {isExpanded ? (
                <ChevronDown className={`w-4 h-4 mr-1 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`} />
              ) : (
                <ChevronRight className={`w-4 h-4 mr-1 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`} />
              )}
              <Folder className="w-4 h-4 mr-2 text-blue-500" />
            </>
          ) : (
            <>
              <div className="w-4 h-4 mr-1" />
              {entry.is_parquet ? (
                <FileText className="w-4 h-4 mr-2 text-green-500" />
              ) : (
                <File className="w-4 h-4 mr-2 text-gray-400" />
              )}
            </>
          )}
          <span className={`flex-1 text-sm truncate ${
            isDisabled 
              ? effectiveTheme === 'dark' ? 'text-gray-500' : 'text-gray-400'
              : effectiveTheme === 'dark' ? 'text-gray-200' : 'text-gray-800'
          }`}>{entry.name}</span>
          {!entry.is_directory && (
            <span className={`text-xs ml-2 ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
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
    <div className={`${effectiveTheme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-r overflow-y-auto ${className}`}>
      <div className={`p-3 border-b ${effectiveTheme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}>
        <h3 className={`text-sm font-semibold ${effectiveTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>File Explorer</h3>
        {currentDir && (
          <p className={`text-xs mt-1 truncate ${effectiveTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`} title={currentDir}>
            {currentDir}
          </p>
        )}
      </div>
      <div className="py-1">
        {entries.map(entry => renderEntry(entry))}
      </div>
    </div>
  );
};

export default FileExplorer;