import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BreadcrumbNav } from '../breadcrumb-nav';

describe('BreadcrumbNav', () => {
  const defaultProps = {
    currentDir: '/Users/test/Documents',
    onNavigate: vi.fn(),
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('returns null when currentDir is empty', () => {
      const { container } = render(
        <BreadcrumbNav currentDir="" onNavigate={vi.fn()} />
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders root segment and path segments', () => {
      render(<BreadcrumbNav {...defaultProps} />);

      // Root segment uses translated '/' value
      expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'test' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Documents' })).toBeInTheDocument();
    });

    it('splits the path correctly into segments', () => {
      render(<BreadcrumbNav currentDir="/a/b/c" onNavigate={vi.fn()} />);

      const buttons = screen.getAllByRole('button');
      // root + a + b + c = 4
      expect(buttons).toHaveLength(4);
      expect(buttons[0]).toHaveTextContent('/');
      expect(buttons[1]).toHaveTextContent('a');
      expect(buttons[2]).toHaveTextContent('b');
      expect(buttons[3]).toHaveTextContent('c');
    });

    it('renders root directory correctly', () => {
      render(<BreadcrumbNav currentDir="/" onNavigate={vi.fn()} />);

      const buttons = screen.getAllByRole('button');
      // Only root
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveTextContent('/');
    });
  });

  describe('truncation', () => {
    it('does not truncate when segments count is within limit', () => {
      // MAX_VISIBLE_SEGMENTS = 3, root + 3 path segments = 4 total, which is within limit (3+1=4)
      render(<BreadcrumbNav currentDir="/a/b/c" onNavigate={vi.fn()} />);

      expect(screen.queryByText('...')).not.toBeInTheDocument();
    });

    it('truncates long paths with ellipsis', () => {
      // root + 5 segments = 6 total, exceeds MAX_VISIBLE_SEGMENTS + 1 = 4
      render(
        <BreadcrumbNav currentDir="/a/b/c/d/e" onNavigate={vi.fn()} />
      );

      expect(screen.getByText('...')).toBeInTheDocument();
      // Should show root + last 3 segments
      expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'c' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'd' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'e' })).toBeInTheDocument();
      // 'a' and 'b' should not be visible
      expect(screen.queryByRole('button', { name: 'a' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'b' })).not.toBeInTheDocument();
    });

    it('shows exactly MAX_VISIBLE_SEGMENTS + 1 (root) segments when truncated', () => {
      render(
        <BreadcrumbNav currentDir="/a/b/c/d/e/f/g" onNavigate={vi.fn()} />
      );

      // root + last 3 = 4 buttons
      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(4);
    });
  });

  describe('navigation', () => {
    it('calls onNavigate with correct path when segment is clicked', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      render(<BreadcrumbNav currentDir="/Users/test/Documents" onNavigate={onNavigate} />);

      await user.click(screen.getByRole('button', { name: 'Users' }));
      expect(onNavigate).toHaveBeenCalledWith('/Users');
    });

    it('calls onNavigate with root path when root is clicked', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      render(<BreadcrumbNav currentDir="/Users/test" onNavigate={onNavigate} />);

      await user.click(screen.getByRole('button', { name: '/' }));
      expect(onNavigate).toHaveBeenCalledWith('/');
    });

    it('calls onNavigate with full path when last segment is clicked', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      render(<BreadcrumbNav currentDir="/a/b/c" onNavigate={onNavigate} />);

      await user.click(screen.getByRole('button', { name: 'c' }));
      expect(onNavigate).toHaveBeenCalledWith('/a/b/c');
    });

    it('navigates correctly for truncated segments', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      render(
        <BreadcrumbNav currentDir="/a/b/c/d/e" onNavigate={onNavigate} />
      );

      // Click the last segment 'e'
      await user.click(screen.getByRole('button', { name: 'e' }));
      expect(onNavigate).toHaveBeenCalledWith('/a/b/c/d/e');
    });
  });

  describe('title attribute', () => {
    it('sets title attribute on segments for full path tooltip', () => {
      render(<BreadcrumbNav currentDir="/Users/test" onNavigate={vi.fn()} />);

      const usersButton = screen.getByRole('button', { name: 'Users' });
      expect(usersButton).toHaveAttribute('title', '/Users');
    });

    it('sets container title to full currentDir', () => {
      const { container } = render(
        <BreadcrumbNav currentDir="/Users/test" onNavigate={vi.fn()} />
      );

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveAttribute('title', '/Users/test');
    });
  });
});
