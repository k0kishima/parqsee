import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, FolderOpen } from 'lucide-react';
import { listDirectory, FileEntry } from '../api';
import type { WorkspaceRoot } from '../../workspace/api';
import { ContextMenu } from '../components/context-menu';
import { BreadcrumbNav } from '../components/breadcrumb-nav';
import { ExplorerEntry } from '../components/explorer-entry';
import { TOP_ROW_HEIGHT } from '../../layout';
import { toErrorMessage } from '../../../lib/tauri';
import { ancestorsWithin, dirname, isWithin } from '../../../lib/path';
import { withShortcut } from '../../../lib/shortcuts';

interface FileExplorerProps {
  /** The folders open in the workspace, each the top of its own tree. */
  roots: readonly WorkspaceRoot[];
  currentPath?: string | null;
  onFileSelect: (path: string) => void;
  onOpenFolder: () => void;
  onRemoveRoot: (path: string) => void;
  className?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: FileEntry;
}

/** The entry at `path` anywhere in the loaded tree. */
function findEntry(entries: readonly FileEntry[], path: string): FileEntry | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.children && isWithin(entry.path, path)) {
      const found = findEntry(entry.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

/** Replace the entry at `path` anywhere in the loaded tree. */
function updateEntry(entries: FileEntry[], path: string, update: (entry: FileEntry) => FileEntry): FileEntry[] {
  return entries.map(entry => {
    if (entry.path === path) return update(entry);
    if (entry.children && path.startsWith(entry.path + '/')) {
      return { ...entry, children: updateEntry(entry.children, path, update) };
    }
    return entry;
  });
}

/**
 * The loaded tree narrowed to `query`: an entry stays when its own name
 * matches or something below it does, so a match deep in a subfolder is
 * still reachable through its parents.
 */
function filterTree(entries: FileEntry[], query: string): FileEntry[] {
  return entries.flatMap(entry => {
    const children = entry.children ? filterTree(entry.children, query) : undefined;
    const selfMatches = entry.name.toLowerCase().includes(query);
    if (!selfMatches && !(children && children.length > 0)) return [];
    return [children ? { ...entry, children } : entry];
  });
}

const rootEntry = (root: WorkspaceRoot): FileEntry => ({
  path: root.path,
  name: root.name,
  is_directory: true,
  is_parquet: false,
});

export const FileExplorer: React.FC<FileExplorerProps> = ({
  roots,
  currentPath,
  onFileSelect,
  onOpenFolder,
  onRemoveRoot,
  className,
}) => {
  // One top-level entry per workspace root; folders below load on expand.
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  // The last rendered tree, readable from callbacks without retriggering them.
  const treeRef = useRef<FileEntry[]>([]);
  treeRef.current = tree;
  // Listings in flight, so two callers wanting the same folder (a root
  // being added and the active file inside it being revealed) share one.
  const inflightRef = useRef(new Map<string, Promise<void>>());

  const loadSubDirectory = useCallback((parentPath: string): Promise<void> => {
    const pending = inflightRef.current.get(parentPath);
    if (pending) return pending;
    const task = (async () => {
      try {
        const result = await listDirectory(parentPath);
        setTree(prev => updateEntry(prev, parentPath, entry => ({ ...entry, children: result, loadError: undefined })));
      } catch (error) {
        console.error('Failed to load directory:', error);
        // Leave the folder expanded with the reason where its children would
        // be, instead of an arrow that opens onto nothing.
        setTree(prev => updateEntry(prev, parentPath, entry => ({ ...entry, children: [], loadError: toErrorMessage(error) })));
      } finally {
        inflightRef.current.delete(parentPath);
      }
    })();
    inflightRef.current.set(parentPath, task);
    return task;
  }, []);

  // Keep one tree per root, preserving what is loaded under roots that stay.
  // A root that was just opened is expanded straight away.
  useEffect(() => {
    const added = roots.filter(root => !treeRef.current.some(entry => entry.path === root.path));
    setTree(prev => roots.map(root => prev.find(entry => entry.path === root.path) ?? rootEntry(root)));
    if (added.length > 0) {
      setExpandedDirs(prev => new Set([...prev, ...added.map(root => root.path)]));
      added.forEach(root => loadSubDirectory(root.path));
    }
  }, [roots, loadSubDirectory]);

  /** Expand every folder from the root down to `dir`, loading what is not loaded yet. */
  const reveal = useCallback(async (rootPath: string, dir: string) => {
    const chain = ancestorsWithin(rootPath, dir);
    if (chain.length === 0) return;
    setExpandedDirs(prev => new Set([...prev, ...chain]));
    for (const path of chain) {
      // A level not loaded yet is listed before the next one is looked
      // for; the tree ref may lag a render, which costs at most a re-list.
      if (!findEntry(treeRef.current, path)?.children) {
        await loadSubDirectory(path);
      }
    }
  }, [loadSubDirectory]);

  // The root the active tab's file lies in, as a path so that opening or
  // closing some other root does not change it.
  const currentRootPath = useMemo(
    () => (currentPath ? roots.find(r => isWithin(r.path, currentPath))?.path : undefined),
    [roots, currentPath]
  );

  // The active tab's file is highlighted and, when it lies in a workspace
  // root, brought into view. A file outside every root (dropped, or picked
  // with ⌘O) leaves the tree alone: under the sandbox its folder cannot be
  // listed anyway. This must not depend on `roots` itself: it would run
  // again whenever another root is opened or closed and re-expand the
  // folders down to the active file after the user collapsed them.
  useEffect(() => {
    if (!currentPath) return;
    setSelectedFile(currentPath);
    if (currentRootPath) reveal(currentRootPath, dirname(currentPath));
  }, [currentPath, currentRootPath, reveal]);

  const toggleDirectory = useCallback((entry: FileEntry) => {
    setExpandedDirs(prev => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(entry.path)) {
        newExpanded.delete(entry.path);
      } else {
        newExpanded.add(entry.path);
        loadSubDirectory(entry.path);
      }
      return newExpanded;
    });
  }, [loadSubDirectory]);

  const handleFileClick = useCallback((entry: FileEntry) => {
    if (entry.is_directory) {
      toggleDirectory(entry);
    } else if (entry.is_parquet) {
      setSelectedFile(entry.path);
      onFileSelect(entry.path);
    }
  }, [toggleDirectory, onFileSelect]);

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

  const filteredTree = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return query ? filterTree(tree, query) : tree;
  }, [tree, searchQuery]);

  const selectedRoot = useMemo(
    () => (selectedFile ? roots.find(r => isWithin(r.path, selectedFile)) : undefined),
    [roots, selectedFile]
  );

  return (
    <div
      ref={containerRef}
      className={`relative bg-primary border-primary border-r overflow-y-auto ${className}`}
    >
      {/* As tall as the panel's own top row, so the two headings and the
          two borders line up across the divider. The breadcrumb is a row
          of its own for the same reason: inside this one it would make the
          sidebar's header taller than the panel's whenever a file is
          selected. */}
      <div className={`px-3 flex items-center justify-between border-b border-primary ${TOP_ROW_HEIGHT}`}>
        <h3 className="text-sm font-semibold text-secondary">{t('common.fileExplorer')}</h3>
        <button
          onClick={onOpenFolder}
          className="p-1 rounded hover:bg-tertiary text-tertiary hover:text-primary"
          title={withShortcut(t('common.openFolder'), 'open-folder')}
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
      {selectedRoot && selectedFile && (
        <div className="px-3 py-1.5 border-b border-primary">
          <BreadcrumbNav
            root={selectedRoot}
            dir={dirname(selectedFile)}
            onNavigate={dir => reveal(selectedRoot.path, dir)}
          />
        </div>
      )}
      {roots.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-xs text-tertiary mb-3">{t('fileExplorer.empty')}</p>
          <button onClick={onOpenFolder} className="btn-primary text-xs">
            {t('common.openFolder')}
          </button>
        </div>
      ) : (
        <>
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
            {filteredTree.map(entry => (
              <ExplorerEntry
                key={entry.path}
                entry={entry}
                level={0}
                selectedFile={selectedFile}
                expandedDirs={expandedDirs}
                onEntryClick={handleFileClick}
                onEntryContextMenu={handleContextMenu}
                onRemoveRoot={onRemoveRoot}
              />
            ))}
          </div>
        </>
      )}

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
