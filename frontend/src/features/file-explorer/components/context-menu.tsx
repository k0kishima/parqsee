import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, FolderOpen, ExternalLink } from 'lucide-react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { FileEntry } from '../api';
import { useGlobalKeydown } from '../../../hooks/useGlobalKeydown';

interface ContextMenuProps {
  x: number;
  y: number;
  entry: FileEntry;
  onClose: () => void;
  onFileSelect: (path: string) => void;
}

export function ContextMenu({ x, y, entry, onClose, onFileSelect }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  useGlobalKeydown(
    useCallback((e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    }, [onClose]),
    'document'
  );

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(entry.path);
    } catch (error) {
      console.error('Failed to copy path:', error);
    }
    onClose();
  }, [entry.path, onClose]);

  const handleRevealInFinder = useCallback(async () => {
    try {
      await revealItemInDir(entry.path);
    } catch (error) {
      console.error('Failed to reveal in Finder:', error);
    }
    onClose();
  }, [entry.path, onClose]);

  const handleOpenInNewTab = useCallback(() => {
    if (!entry.is_parquet) return;
    onFileSelect(entry.path);
    onClose();
  }, [entry.path, entry.is_parquet, onFileSelect, onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="absolute z-50 min-w-[160px] rounded-md shadow-lg border border-primary bg-primary py-1"
      style={{ left: x, top: y }}
    >
      <button
        role="menuitem"
        onClick={handleCopyPath}
        className="w-full flex items-center px-3 py-1.5 text-xs text-primary hover:bg-tertiary"
      >
        <Copy className="w-3.5 h-3.5 mr-2" />
        {t('fileExplorer.contextMenu.copyPath')}
      </button>
      <button
        role="menuitem"
        onClick={handleRevealInFinder}
        className="w-full flex items-center px-3 py-1.5 text-xs text-primary hover:bg-tertiary"
      >
        <FolderOpen className="w-3.5 h-3.5 mr-2" />
        {t('fileExplorer.contextMenu.revealInFinder')}
      </button>
      {!entry.is_directory && (
        <button
          role="menuitem"
          onClick={handleOpenInNewTab}
          disabled={!entry.is_parquet}
          className={`w-full flex items-center px-3 py-1.5 text-xs text-primary
            ${entry.is_parquet ? 'hover:bg-tertiary' : 'opacity-50 cursor-not-allowed'}`}
        >
          <ExternalLink className="w-3.5 h-3.5 mr-2" />
          {t('fileExplorer.contextMenu.openInNewTab')}
        </button>
      )}
    </div>
  );
}
