import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileExplorer } from '../file-explorer';
import type { FileEntry } from '../../api';

// Mock the API module
const mockListDirectory = vi.fn();
vi.mock('../../api', () => ({
  listDirectory: (...args: unknown[]) => mockListDirectory(...args),
}));

const sampleEntries: FileEntry[] = [
  { path: '/test/data.parquet', name: 'data.parquet', is_directory: false, is_parquet: true, size: 1024 },
  { path: '/test/other.parquet', name: 'other.parquet', is_directory: false, is_parquet: true, size: 2048 },
  { path: '/test/readme.txt', name: 'readme.txt', is_directory: false, is_parquet: false, size: 256 },
  { path: '/test/subdir', name: 'subdir', is_directory: true, is_parquet: false },
  { path: '/test/Report.PARQUET', name: 'Report.PARQUET', is_directory: false, is_parquet: true, size: 4096 },
];

describe('FileExplorer', () => {
  const defaultProps = {
    onFileSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListDirectory.mockResolvedValue(sampleEntries);
  });

  describe('initial rendering', () => {
    it('renders the file explorer header', () => {
      render(<FileExplorer {...defaultProps} />);
      expect(screen.getByText('File Explorer')).toBeInTheDocument();
    });

    it('renders the search input', () => {
      render(<FileExplorer {...defaultProps} />);
      expect(screen.getByPlaceholderText('Filter files...')).toBeInTheDocument();
    });
  });

  describe('file loading with currentPath', () => {
    it('loads directory when currentPath is provided', async () => {
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(mockListDirectory).toHaveBeenCalledWith('/test');
      });
    });

    it('displays entries after loading', async () => {
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
        expect(screen.getByText('other.parquet')).toBeInTheDocument();
        expect(screen.getByText('readme.txt')).toBeInTheDocument();
        expect(screen.getByText('subdir')).toBeInTheDocument();
      });
    });
  });

  describe('search/filter', () => {
    it('filters entries by search query', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Filter files...');
      await user.type(searchInput, 'data');

      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument();
      expect(screen.queryByText('subdir')).not.toBeInTheDocument();
    });

    it('performs case-insensitive filtering', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Filter files...');
      await user.type(searchInput, 'PARQUET');

      // Should match data.parquet, other.parquet, and Report.PARQUET (case-insensitive on name)
      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(screen.getByText('other.parquet')).toBeInTheDocument();
      expect(screen.getByText('Report.PARQUET')).toBeInTheDocument();
      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument();
    });

    it('shows all entries when search is cleared', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Filter files...');
      await user.type(searchInput, 'data');

      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument();

      // Click the clear button
      const clearButton = screen.getByTitle('Clear search');
      await user.click(clearButton);

      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(screen.getByText('readme.txt')).toBeInTheDocument();
      expect(screen.getByText('subdir')).toBeInTheDocument();
    });

    it('shows no entries when search has no matches', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Filter files...');
      await user.type(searchInput, 'nonexistent');

      expect(screen.queryByText('data.parquet')).not.toBeInTheDocument();
      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument();
      expect(screen.queryByText('subdir')).not.toBeInTheDocument();
    });

    it('does not show clear button when search is empty', () => {
      render(<FileExplorer {...defaultProps} />);
      expect(screen.queryByTitle('Clear search')).not.toBeInTheDocument();
    });

    it('shows clear button when search has text', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Filter files...');
      await user.type(searchInput, 'a');

      expect(screen.getByTitle('Clear search')).toBeInTheDocument();
    });

    it('handles special characters in search query', async () => {
      const user = userEvent.setup();
      const specialEntries: FileEntry[] = [
        { path: '/test/file (1).parquet', name: 'file (1).parquet', is_directory: false, is_parquet: true, size: 100 },
        { path: '/test/normal.parquet', name: 'normal.parquet', is_directory: false, is_parquet: true, size: 200 },
      ];
      mockListDirectory.mockResolvedValue(specialEntries);

      render(<FileExplorer {...defaultProps} currentPath="/test/file (1).parquet" />);

      await waitFor(() => {
        expect(screen.getByText('file (1).parquet')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Filter files...');
      await user.type(searchInput, '(1)');

      expect(screen.getByText('file (1).parquet')).toBeInTheDocument();
      expect(screen.queryByText('normal.parquet')).not.toBeInTheDocument();
    });

    it('trims whitespace-only search to show all entries', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Filter files...');
      await user.type(searchInput, '   ');

      // Whitespace-only should show all entries (searchQuery.trim() returns empty)
      expect(screen.getByText('data.parquet')).toBeInTheDocument();
      expect(screen.getByText('readme.txt')).toBeInTheDocument();
    });
  });

  describe('file selection', () => {
    it('calls onFileSelect when a parquet file is clicked', async () => {
      const user = userEvent.setup();
      const onFileSelect = vi.fn();
      render(<FileExplorer currentPath="/test/data.parquet" onFileSelect={onFileSelect} />);

      await waitFor(() => {
        expect(screen.getByText('other.parquet')).toBeInTheDocument();
      });

      await user.click(screen.getByText('other.parquet'));
      expect(onFileSelect).toHaveBeenCalledWith('/test/other.parquet');
    });

    it('does not call onFileSelect for non-parquet files', async () => {
      const user = userEvent.setup();
      const onFileSelect = vi.fn();
      render(<FileExplorer currentPath="/test/data.parquet" onFileSelect={onFileSelect} />);

      await waitFor(() => {
        expect(screen.getByText('readme.txt')).toBeInTheDocument();
      });

      await user.click(screen.getByText('readme.txt'));
      expect(onFileSelect).not.toHaveBeenCalled();
    });
  });

  describe('context menu', () => {
    it('shows context menu on right-click', async () => {
      const user = userEvent.setup();
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('data.parquet')).toBeInTheDocument();
      });

      // Right-click on the file entry
      const fileEntry = screen.getByText('data.parquet');
      await user.pointer({ keys: '[MouseRight]', target: fileEntry });

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.getByText('Copy Path')).toBeInTheDocument();
    });
  });

  describe('breadcrumb navigation', () => {
    it('renders breadcrumb when directory is loaded', async () => {
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        // BreadcrumbNav should be rendered
        expect(screen.getByText('test')).toBeInTheDocument();
      });
    });
  });

  describe('file size formatting', () => {
    it('displays formatted file sizes', async () => {
      render(<FileExplorer {...defaultProps} currentPath="/test/data.parquet" />);

      await waitFor(() => {
        expect(screen.getByText('1.0 KB')).toBeInTheDocument(); // 1024 bytes
      });
    });
  });
});
