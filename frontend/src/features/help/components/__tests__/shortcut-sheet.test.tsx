import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShortcutSheet } from '../shortcut-sheet';
import { SHORTCUTS, SHORTCUT_SECTIONS } from '../../../../lib/shortcuts';

describe('ShortcutSheet', () => {
  it('lists every shortcut under its section, with its keys', () => {
    render(<ShortcutSheet isOpen onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'shortcuts.title' })).toBeInTheDocument();
    for (const section of SHORTCUT_SECTIONS) {
      expect(screen.getByRole('heading', { name: `shortcuts.sections.${section}` })).toBeInTheDocument();
    }
    for (const shortcut of SHORTCUTS) {
      expect(screen.getByText(`shortcuts.${shortcut.id}`)).toBeInTheDocument();
    }
    expect(screen.getByText('⇧⌘O')).toBeInTheDocument();
    // Alternatives get a keycap each.
    expect(screen.getByText('⇧⌘]')).toBeInTheDocument();
    expect(screen.getByText('⌥⌘→')).toBeInTheDocument();
  });

  it('closes on Escape, on ✕ and on the backdrop, and renders nothing while closed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<ShortcutSheet isOpen onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'common.close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);

    rerender(<ShortcutSheet isOpen={false} onClose={onClose} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
