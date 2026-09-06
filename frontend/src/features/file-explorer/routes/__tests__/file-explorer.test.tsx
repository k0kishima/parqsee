import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileExplorer } from '../file-explorer';
import type { FileEntry } from '../../api';

// Mock the API module
const mockListDirectory = vi.fn();
vi.mock('../../api', () => ({
  listDirectory: (...args: unknown[]) => mockListDirectory(...args),
}));

const testRoot = { path: '/test', name: 'test' };

const sampleEntries: FileEntry[] = [
  { path: '/test/data.parquet', name: 'data.parquet', is_directory: false, is_parquet: true, size: 1024 },
  { path: '/test/other.parquet', name: 'other.parquet', is_directory: false, is_parquet: true, size: 2048 },
  { path: '/test/readme.txt', name: 'readme.txt', is_directory: false, is_parquet: false, size: 256 },
  { path: '/test/subdir', name: 'subdir', is_directory: true, is_parquet: false },
  { path: '/test/Report.PARQUET', name: 'Report.PARQUET', is_directory: false, is_parquet: true, size: 4096 },
];

const subdirEntries: FileEntry[] = [
  { path: '/test/subdir/nested.parquet', name: 'nested.parquet', is_directory: false, is_parquet: true, size: 512 },
];

/** Answer listings by path, the way the backend would. */
function listByPath(listings: Record<string, FileEntry[]>) {
  mockListDirectory.mockImplementation(async (path: unknown) => {
    const entries = listings[path as string];
    if (!entries) throw `Directory does not exist: ${path}`;
    return entries;
  });
}

describe('FileExplorer', () => {
  const defaultProps = {
    roots: [testRoot],
    onFileSelect: vi.fn(),
    onOpenFolder: vi.fn(),
    onRemoveRoot: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listByPath({ '/test': sampleEntries, '/test/subdir': subdirEntries });
  });

  describe('without a workspace folder', () => {
    it('shows the empty state with an Open Folder button and no search box', async () => {
      const user = userEvent.setup();
      const onOpenFolder = vi.fn();
      render(<FileExplorer {...defaultProps} roots={[]} onOpenFolder={onOpenFolder} />);

      expect(screen.getByText('File Explorer')).toBeInTheDocument();
      expect(screen.getByText('Open a folder to browse Parquet files')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Filter files...')).not.toBeInTheDocument();
      expect(mockListDirectory).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Open Folder' }));
      expect(onOpenFolder).toHaveBeenCalled();
    });

    it('does not list the folder of a file that is outside every root', async () => {
      render(<FileExplorer {...defaultProps} roots={[]} currentPath="/dropped/file.parquet" />);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockListDirectory).not.toHaveBeenCalled();
    });
  });

  describe('workspace roots', () => {
    it('lists each root expanded, by name, and loads its entries', async () => {
      render(<FileExplorer {...defaultProps} />);

      expect(screen.getByText('test')).toBeInTheDocument();
      await waitFor(() => {
        expect(mockListDirectory).toHaveBeenCalledWith('/test');
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
        expect(screen.getByText('other.parquet')).toBeInTheDocument();
        expect(screen.getByText('readme.txt')).toBeInTheDocument();
        expect(screen.getByText('subdir')).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText('Filter files...')).toBeInTheDocument();
    });

    it('adds a root opened later without reloading the others', async () => {
      listByPath({ '/test': sampleEntries, '/more': [{ path: '/more/extra.parquet', name: 'extra.parquet', is_directory: false, is_parquet: true, size: 1 }] });
      const { rerender } = render(<FileExplorer {...defaultProps} />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());

      rerender(<FileExplorer {...defaultProps} roots={[testRoot, { path: '/more', name: 'more' }]} />);
      await waitFor(() => expect(screen.getByText('extra.parquet')).toBeInTheDocument());
      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(mockListDirectory).toHaveBeenCalledTimes(2);
    });

    it('drops a removed root from the tree', async () => {
      const { rerender } = render(<FileExplorer {...defaultProps} />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());

      rerender(<FileExplorer {...defaultProps} roots={[]} />);
      expect(screen.queryByText('data.parquet')).not.toBeInTheDocument();
      expect(screen.getByText('Open a folder to browse Parquet files')).toBeInTheDocument();
    });

    it('offers to remove a root from its row', async () => {
      const user = userEvent.setup();
      const onRemoveRoot = vi.fn();
      render(<FileExplorer {...defaultProps} onRemoveRoot={onRemoveRoot} />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Remove folder from workspace' }));
      expect(onRemoveRoot).toHaveBeenCalledWith('/test');
      // The click does not also toggle the root.
      expect(screen.getByText('data.parquet')).toBeInTheDocument();
    });

    it('shows why a root could not be listed', async () => {
      mockListDirectory.mockRejectedValueOnce('Permission denied (os error 13)');
      render(<FileExplorer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Permission denied (os error 13)');
      });
    });
  });

  describe('search/filter', () => {
    async function renderLoaded(props = {}) {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} {...props} />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());
      return { user, searchInput: screen.getByPlaceholderText('Filter files...') };
    }

    it('filters entries by search query', async () => {
      const { user, searchInput } = await renderLoaded();
      await user.type(searchInput, 'data');

      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument();
      expect(screen.queryByText('subdir')).not.toBeInTheDocument();
    });

    it('performs case-insensitive filtering', async () => {
      const { user, searchInput } = await renderLoaded();
      await user.type(searchInput, 'PARQUET');

      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(screen.getByText('other.parquet')).toBeInTheDocument();
      expect(screen.getByText('Report.PARQUET')).toBeInTheDocument();
      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument();
    });

    it('keeps the folders above a match inside an expanded subfolder', async () => {
      const { user, searchInput } = await renderLoaded();
      await user.click(screen.getByText('subdir'));
      await waitFor(() => expect(screen.getByText('nested.parquet')).toBeInTheDocument());

      await user.type(searchInput, 'nested');

      expect(screen.getByText('test')).toBeInTheDocument();
      expect(screen.getByText('subdir')).toBeInTheDocument();
      expect(screen.getByText('nested.parquet')).toBeInTheDocument();
      expect(screen.queryByText('data.parquet')).not.toBeInTheDocument();
    });

    it('shows all entries when search is cleared', async () => {
      const { user, searchInput } = await renderLoaded();
      await user.type(searchInput, 'data');
      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument();

      await user.click(screen.getByTitle('Clear search'));

      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(screen.getByText('readme.txt')).toBeInTheDocument();
      expect(screen.getByText('subdir')).toBeInTheDocument();
    });

    it('shows no entries when search has no matches', async () => {
      const { user, searchInput } = await renderLoaded();
      await user.type(searchInput, 'nonexistent');

      expect(screen.queryByText('data.parquet')).not.toBeInTheDocument();
      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument();
      expect(screen.queryByText('subdir')).not.toBeInTheDocument();
      expect(screen.queryByText('test')).not.toBeInTheDocument();
    });

    it('only shows the clear button while there is a query', async () => {
      const { user, searchInput } = await renderLoaded();
      expect(screen.queryByTitle('Clear search')).not.toBeInTheDocument();
      await user.type(searchInput, 'a');
      expect(screen.getByTitle('Clear search')).toBeInTheDocument();
    });

    it('handles special characters in search query', async () => {
      listByPath({
        '/test': [
          { path: '/test/file (1).parquet', name: 'file (1).parquet', is_directory: false, is_parquet: true, size: 100 },
          { path: '/test/normal.parquet', name: 'normal.parquet', is_directory: false, is_parquet: true, size: 200 },
        ],
      });
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} />);
      await waitFor(() => expect(screen.getByText('file (1).parquet')).toBeInTheDocument());

      await user.type(screen.getByPlaceholderText('Filter files...'), '(1)');

      expect(screen.getByText('file (1).parquet')).toBeInTheDocument();
      expect(screen.queryByText('normal.parquet')).not.toBeInTheDocument();
    });

    it('trims whitespace-only search to show all entries', async () => {
      const { user, searchInput } = await renderLoaded();
      await user.type(searchInput, '   ');

      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(screen.getByText('readme.txt')).toBeInTheDocument();
    });
  });

  describe('file selection', () => {
    it('calls onFileSelect when a parquet file is clicked', async () => {
      const user = userEvent.setup();
      const onFileSelect = vi.fn();
      render(<FileExplorer {...defaultProps} onFileSelect={onFileSelect} />);
      await waitFor(() => expect(screen.getByText('other.parquet')).toBeInTheDocument());

      await user.click(screen.getByText('other.parquet'));
      expect(onFileSelect).toHaveBeenCalledWith('/test/other.parquet');
    });

    it('does not call onFileSelect for non-parquet files', async () => {
      const user = userEvent.setup();
      const onFileSelect = vi.fn();
      render(<FileExplorer {...defaultProps} onFileSelect={onFileSelect} />);
      await waitFor(() => expect(screen.getByText('readme.txt')).toBeInTheDocument());

      await user.click(screen.getByText('readme.txt'));
      expect(onFileSelect).not.toHaveBeenCalled();
    });
  });

  describe('directory expansion', () => {
    it('loads and shows children when a directory is clicked, and hides them on the second click', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} />);
      await waitFor(() => expect(screen.getByText('subdir')).toBeInTheDocument());

      await user.click(screen.getByText('subdir'));
      await waitFor(() => expect(screen.getByText('nested.parquet')).toBeInTheDocument());
      expect(mockListDirectory).toHaveBeenCalledWith('/test/subdir');

      await user.click(screen.getByText('subdir'));
      expect(screen.queryByText('nested.parquet')).not.toBeInTheDocument();
    });

    it('collapses and re-expands a root', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());

      await user.click(screen.getByText('test'));
      expect(screen.queryByText('data.parquet')).not.toBeInTheDocument();
      await user.click(screen.getByText('test'));
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());
    });

    it('shows the reason under a subfolder that could not be expanded', async () => {
      listByPath({ '/test': sampleEntries });
      render(<FileExplorer {...defaultProps} />);
      await waitFor(() => expect(screen.getByText('subdir')).toBeInTheDocument());

      await userEvent.click(screen.getByText('subdir'));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Directory does not exist');
      });
      // The rest of the listing is untouched.
      expect(screen.getByText('data.parquet')).toBeInTheDocument();
    });
  });

  describe('the active tab', () => {
    it('highlights the file without reloading its folder', async () => {
      const { rerender } = render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);
      await waitFor(() => expect(screen.getByText('data.parquet').closest('div')).toHaveClass('bg-selected'));
      expect(mockListDirectory).toHaveBeenCalledTimes(1);

      rerender(<FileExplorer {...defaultProps} currentPath="/test/other.parquet" />);
      await waitFor(() => expect(screen.getByText('other.parquet').closest('div')).toHaveClass('bg-selected'));
      expect(screen.getByText('data.parquet').closest('div')).not.toHaveClass('bg-selected');
      expect(mockListDirectory).toHaveBeenCalledTimes(1);
    });

    it('expands the folders down to a file deeper in the root', async () => {
      listByPath({
        '/test': sampleEntries,
        '/test/subdir': [{ path: '/test/subdir/deep', name: 'deep', is_directory: true, is_parquet: false }],
        '/test/subdir/deep': [{ path: '/test/subdir/deep/inner.parquet', name: 'inner.parquet', is_directory: false, is_parquet: true, size: 1 }],
      });
      render(<FileExplorer {...defaultProps} currentPath="/test/subdir/deep/inner.parquet" />);

      await waitFor(() => expect(screen.getByText('inner.parquet').closest('div')).toHaveClass('bg-selected'));
      expect(mockListDirectory).toHaveBeenCalledWith('/test/subdir');
      expect(mockListDirectory).toHaveBeenCalledWith('/test/subdir/deep');
      expect(screen.getByText('data.parquet')).toBeInTheDocument();
    });

    it('keeps a collapsed root collapsed when another root is opened', async () => {
      const user = userEvent.setup();
      listByPath({
        '/test': sampleEntries,
        '/b': [{ path: '/b/y.parquet', name: 'y.parquet', is_directory: false, is_parquet: true, size: 1 }],
        '/c': [{ path: '/c/z.parquet', name: 'z.parquet', is_directory: false, is_parquet: true, size: 1 }],
      });
      const { rerender } = render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());
      // The breadcrumb names the root too; the tree row is the span.
      await user.click(screen.getByText('test', { selector: 'span' }));
      expect(screen.queryByText('data.parquet')).not.toBeInTheDocument();

      const b = { path: '/b', name: 'b' };
      rerender(<FileExplorer {...defaultProps} roots={[testRoot, b]} currentPath="/test/data.parquet" />);
      await waitFor(() => expect(screen.getByText('y.parquet')).toBeInTheDocument());
      expect(screen.queryByText('data.parquet')).not.toBeInTheDocument();

      await user.click(screen.getByText('b', { selector: 'span' }));
      rerender(<FileExplorer {...defaultProps} roots={[testRoot, b, { path: '/c', name: 'c' }]} currentPath="/test/data.parquet" />);
      await waitFor(() => expect(screen.getByText('z.parquet')).toBeInTheDocument());
      expect(screen.queryByText('data.parquet')).not.toBeInTheDocument();
      expect(screen.queryByText('y.parquet')).not.toBeInTheDocument();
    });

    it('reveals the active file once its folder is opened as a root', async () => {
      listByPath({ '/test': sampleEntries, '/test/subdir': subdirEntries });
      const { rerender } = render(<FileExplorer {...defaultProps} roots={[]} currentPath="/test/subdir/nested.parquet" />);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockListDirectory).not.toHaveBeenCalled();

      rerender(<FileExplorer {...defaultProps} roots={[testRoot]} currentPath="/test/subdir/nested.parquet" />);
      await waitFor(() => expect(screen.getByText('nested.parquet').closest('div')).toHaveClass('bg-selected'));
    });

    it('leaves the tree alone for a file outside every root', async () => {
      const { rerender } = render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());

      rerender(<FileExplorer {...defaultProps} currentPath="/elsewhere/deep.parquet" />);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockListDirectory).not.toHaveBeenCalledWith('/elsewhere');
      expect(screen.getByText('data.parquet')).toBeInTheDocument();
    });
  });

  describe('breadcrumb', () => {
    it('shows the selected file\'s folder from the root down, and reveals a clicked folder', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} currentPath="/test/subdir/nested.parquet" />);
      await waitFor(() => expect(screen.getByText('nested.parquet')).toBeInTheDocument());

      const trail = screen.getByRole('navigation');
      expect(trail).toHaveAttribute('title', '/test/subdir');
      expect(within(trail).getAllByRole('button').map(b => b.textContent)).toEqual(['test', 'subdir']);

      // Collapse the subfolder in the tree, then bring it back from the trail.
      await user.click(screen.getByText('subdir', { selector: 'span' }));
      expect(screen.queryByText('nested.parquet')).not.toBeInTheDocument();
      await user.click(within(trail).getByRole('button', { name: 'subdir' }));
      await waitFor(() => expect(screen.getByText('nested.parquet')).toBeInTheDocument());
    });

    it('is hidden while nothing inside a root is selected', async () => {
      render(<FileExplorer {...defaultProps} currentPath="/elsewhere/deep.parquet" />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });
  });

  describe('context menu', () => {
    it('shows context menu on right-click', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} />);
      await waitFor(() => expect(screen.getByText('data.parquet')).toBeInTheDocument());

      await user.pointer({ keys: '[MouseRight]', target: screen.getByText('data.parquet') });

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.getByText('Copy Path')).toBeInTheDocument();
    });
  });

  describe('file size formatting', () => {
    it('displays formatted file sizes', async () => {
      render(<FileExplorer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('1.0 KB')).toBeInTheDocument(); // 1024 bytes
      });
    });
  });
});
