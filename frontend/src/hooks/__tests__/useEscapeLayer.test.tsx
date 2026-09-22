import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useEscapeLayer } from '../useEscapeLayer';

function Layer({ onEscape, active }: { onEscape: () => void; active?: boolean }) {
  useEscapeLayer(onEscape, active);
  return null;
}

describe('useEscapeLayer', () => {
  it('tells only the layer that opened last', () => {
    const under = vi.fn();
    const over = vi.fn();
    const { rerender } = render(<Layer onEscape={under} />);
    rerender(<><Layer onEscape={under} /><Layer onEscape={over} /></>);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(over).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();

    // With the one in front gone, the next press reaches the one behind it.
    rerender(<Layer onEscape={under} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(under).toHaveBeenCalledTimes(1);
    expect(over).toHaveBeenCalledTimes(1);
  });

  it('keeps the press from anything else listening for it', () => {
    const elsewhere = vi.fn();
    const onEscape = vi.fn();
    window.addEventListener('keydown', elsewhere);
    try {
      render(<Layer onEscape={onEscape} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledTimes(1);
      expect(elsewhere).not.toHaveBeenCalled();

      // Only Escape: every other key goes where it was going.
      fireEvent.keyDown(window, { key: 'a' });
      expect(elsewhere).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', elsewhere);
    }
  });

  it('lets the press through once the last layer is gone', () => {
    const elsewhere = vi.fn();
    window.addEventListener('keydown', elsewhere);
    try {
      const { unmount } = render(<Layer onEscape={vi.fn()} />);
      unmount();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(elsewhere).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', elsewhere);
    }
  });

  it('joins the stack when a layer that stays mounted opens', () => {
    const popover = vi.fn();
    const modal = vi.fn();
    const { rerender } = render(<><Layer onEscape={popover} active={false} /><Layer onEscape={modal} /></>);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(modal).toHaveBeenCalledTimes(1);

    rerender(<><Layer onEscape={popover} active={true} /><Layer onEscape={modal} /></>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(popover).toHaveBeenCalledTimes(1);
    expect(modal).toHaveBeenCalledTimes(1);
  });
});
