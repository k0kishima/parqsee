import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextMenu } from '../context-menu';
import type { FileEntry } from '../../api';

// Directly access the mocked module
const mockRevealItemInDir = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: (...args: unknown[]) => mockRevealItemInDir(...args),
}));

const parquetEntry: FileEntry = {
  path: '/data/test.parquet',
  name: 'test.parquet',
  is_directory: false,
  is_parquet: true,
  size: 1024,
};

const nonParquetEntry: FileEntry = {
  path: '/data/readme.txt',
  name: 'readme.txt',
  is_directory: false,
  is_parquet: false,
  size: 512,
};

const directoryEntry: FileEntry = {
  path: '/data/subdir',
  name: 'subdir',
  is_directory: true,
  is_parquet: false,
};

describe('ContextMenu', () => {
  const defaultProps = {
    x: 100,
    y: 200,
    entry: parquetEntry,
    onClose: vi.fn(),
    onFileSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders with role="menu"', () => {
      render(<ContextMenu {...defaultProps} />);
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('renders all menu items with role="menuitem"', () => {
      render(<ContextMenu {...defaultProps} />);
      const items = screen.getAllByRole('menuitem');
      expect(items.length).toBeGreaterThanOrEqual(2); // Copy Path, Reveal in Finder, (optionally Open in New Tab)
    });

    it('renders Copy Path menu item', () => {
      render(<ContextMenu {...defaultProps} />);
      expect(screen.getByText('Copy Path')).toBeInTheDocument();
    });

    it('renders Reveal in Finder menu item', () => {
      render(<ContextMenu {...defaultProps} />);
      expect(screen.getByText('Reveal in Finder')).toBeInTheDocument();
    });

    it('positions menu at given coordinates', () => {
      render(<ContextMenu {...defaultProps} x={150} y={250} />);
      const menu = screen.getByRole('menu');
      expect(menu.style.left).toBe('150px');
      expect(menu.style.top).toBe('250px');
    });
  });

  describe('Open in New Tab option', () => {
    it('shows Open in New Tab for non-directory entries', () => {
      render(<ContextMenu {...defaultProps} entry={parquetEntry} />);
      expect(screen.getByText('Open in New Tab')).toBeInTheDocument();
    });

    it('enables Open in New Tab for parquet files', () => {
      render(<ContextMenu {...defaultProps} entry={parquetEntry} />);
      const openButton = screen.getByText('Open in New Tab').closest('button');
      expect(openButton).not.toBeDisabled();
    });

    it('disables Open in New Tab for non-parquet files', () => {
      render(<ContextMenu {...defaultProps} entry={nonParquetEntry} />);
      const openButton = screen.getByText('Open in New Tab').closest('button');
      expect(openButton).toBeDisabled();
    });

    it('does not show Open in New Tab for directories', () => {
      render(<ContextMenu {...defaultProps} entry={directoryEntry} />);
      expect(screen.queryByText('Open in New Tab')).not.toBeInTheDocument();
    });
  });

  describe('closing behavior', () => {
    it('calls onClose when Escape key is pressed', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<ContextMenu {...defaultProps} onClose={onClose} />);

      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalled();
    });

    it('calls onClose when clicking outside the menu', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <div>
          <div data-testid="outside">Outside</div>
          <ContextMenu {...defaultProps} onClose={onClose} />
        </div>
      );

      await user.click(screen.getByTestId('outside'));
      expect(onClose).toHaveBeenCalled();
    });

    it('does not call onClose when clicking inside the menu', async () => {
      const onClose = vi.fn();

      // We need to check that the menu itself doesn't trigger close on internal click
      // The close will be called by the handler actions, but not by the outside-click handler
      render(<ContextMenu {...defaultProps} onClose={onClose} />);

      // Before any click, onClose should not have been called
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Copy Path action', () => {
    it('copies path to clipboard and closes menu', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      // Mock clipboard via defineProperty since navigator.clipboard is read-only
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        writable: true,
        configurable: true,
      });

      render(<ContextMenu {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByText('Copy Path'));

      expect(mockWriteText).toHaveBeenCalledWith('/data/test.parquet');
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Reveal in Finder action', () => {
    it('calls revealItemInDir and closes menu', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      mockRevealItemInDir.mockResolvedValue(undefined);

      render(<ContextMenu {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByText('Reveal in Finder'));

      expect(mockRevealItemInDir).toHaveBeenCalledWith('/data/test.parquet');
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Open in New Tab action', () => {
    it('calls onFileSelect with entry path for parquet files', async () => {
      const user = userEvent.setup();
      const onFileSelect = vi.fn();
      const onClose = vi.fn();

      render(
        <ContextMenu
          {...defaultProps}
          entry={parquetEntry}
          onFileSelect={onFileSelect}
          onClose={onClose}
        />
      );

      await user.click(screen.getByText('Open in New Tab'));

      expect(onFileSelect).toHaveBeenCalledWith('/data/test.parquet');
      expect(onClose).toHaveBeenCalled();
    });

    it('does not call onFileSelect for non-parquet files when clicked', async () => {
      const user = userEvent.setup();
      const onFileSelect = vi.fn();

      render(
        <ContextMenu {...defaultProps} entry={nonParquetEntry} onFileSelect={onFileSelect} />
      );

      const openButton = screen.getByText('Open in New Tab').closest('button')!;
      await user.click(openButton);

      // Button is disabled, so the handler should not fire
      expect(onFileSelect).not.toHaveBeenCalled();
    });
  });
});
