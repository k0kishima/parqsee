import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BreadcrumbNav } from '../breadcrumb-nav';

const root = { path: '/Users/test', name: 'test' };

describe('BreadcrumbNav', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('returns null when the directory is outside the root', () => {
      const { container } = render(
        <BreadcrumbNav root={root} dir="/elsewhere/deep" onNavigate={vi.fn()} />
      );
      expect(container.firstChild).toBeNull();
    });

    it('starts at the root, shown by its name, and never climbs above it', () => {
      render(<BreadcrumbNav root={root} dir="/Users/test/Documents/reports" onNavigate={vi.fn()} />);

      const buttons = screen.getAllByRole('button');
      expect(buttons.map(b => b.textContent)).toEqual(['test', 'Documents', 'reports']);
      expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '/' })).not.toBeInTheDocument();
    });

    it('shows only the root when the directory is the root itself', () => {
      render(<BreadcrumbNav root={root} dir="/Users/test" onNavigate={vi.fn()} />);

      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveTextContent('test');
    });
  });

  describe('truncation', () => {
    it('does not truncate when segments count is within limit', () => {
      // MAX_VISIBLE_SEGMENTS = 3, root + 3 segments = 4 total, within the limit.
      render(<BreadcrumbNav root={root} dir="/Users/test/a/b/c" onNavigate={vi.fn()} />);

      expect(screen.queryByText('...')).not.toBeInTheDocument();
    });

    it('truncates long paths with ellipsis, keeping the root and the last three', () => {
      render(<BreadcrumbNav root={root} dir="/Users/test/a/b/c/d/e" onNavigate={vi.fn()} />);

      expect(screen.getByText('...')).toBeInTheDocument();
      expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['test', 'c', 'd', 'e']);
    });
  });

  describe('navigation', () => {
    it('calls onNavigate with the directory of the clicked segment', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      render(<BreadcrumbNav root={root} dir="/Users/test/Documents/reports" onNavigate={onNavigate} />);

      await user.click(screen.getByRole('button', { name: 'Documents' }));
      expect(onNavigate).toHaveBeenCalledWith('/Users/test/Documents');
    });

    it('calls onNavigate with the root path when the root is clicked', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      render(<BreadcrumbNav root={root} dir="/Users/test/Documents" onNavigate={onNavigate} />);

      await user.click(screen.getByRole('button', { name: 'test' }));
      expect(onNavigate).toHaveBeenCalledWith('/Users/test');
    });

    it('navigates correctly for truncated segments', async () => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      render(<BreadcrumbNav root={root} dir="/Users/test/a/b/c/d/e" onNavigate={onNavigate} />);

      await user.click(screen.getByRole('button', { name: 'e' }));
      expect(onNavigate).toHaveBeenCalledWith('/Users/test/a/b/c/d/e');
    });
  });

  describe('title attribute', () => {
    it('sets title attribute on segments for full path tooltip', () => {
      render(<BreadcrumbNav root={root} dir="/Users/test/Documents" onNavigate={vi.fn()} />);

      expect(screen.getByRole('button', { name: 'test' })).toHaveAttribute('title', '/Users/test');
      expect(screen.getByRole('button', { name: 'Documents' })).toHaveAttribute('title', '/Users/test/Documents');
    });

    it('sets container title to the full directory', () => {
      const { container } = render(
        <BreadcrumbNav root={root} dir="/Users/test/Documents" onNavigate={vi.fn()} />
      );

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveAttribute('title', '/Users/test/Documents');
    });
  });
});
