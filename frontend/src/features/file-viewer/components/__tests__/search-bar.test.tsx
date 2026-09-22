import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchBar } from '../search-bar';

/** The bar with its handlers spied on, open and with no search run yet. */
const renderBar = () => {
  const handlers = {
    onSearchSubmit: vi.fn(),
    onClose: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
  };
  const bar = (searchTerm: string) => (
    <SearchBar
      isOpen
      searchTerm={searchTerm}
      currentMatch={1}
      totalMatches={2}
      {...handlers}
    />
  );
  const { rerender } = render(bar(''));
  return {
    handlers,
    input: () => screen.getByPlaceholderText('viewer.searchPlaceholder'),
    /** What the viewer does with a submitted term: it applies it trimmed. */
    applied: (term: string) => rerender(bar(term.trim())),
  };
};

describe('SearchBar', () => {
  it('walks the matches of a term entered with surrounding spaces', async () => {
    const { handlers, input, applied } = renderBar();
    const user = userEvent.setup();

    await user.type(input(), 'foo ');
    await user.keyboard('{Enter}');
    expect(handlers.onSearchSubmit).toHaveBeenCalledTimes(1);
    expect(handlers.onSearchSubmit).toHaveBeenCalledWith('foo ');

    // The term in force is what the box holds, spaces aside, so the second
    // Enter is a step to the next match and not the same search again.
    applied('foo ');
    await user.keyboard('{Enter}');
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    expect(handlers.onSearchSubmit).toHaveBeenCalledTimes(1);
  });

  it('searches again when the term itself changed', async () => {
    const { handlers, input, applied } = renderBar();
    const user = userEvent.setup();

    await user.type(input(), 'foo');
    await user.keyboard('{Enter}');
    applied('foo');
    await user.type(input(), 'd');
    await user.keyboard('{Enter}');

    expect(handlers.onSearchSubmit).toHaveBeenLastCalledWith('food');
    expect(handlers.onNext).not.toHaveBeenCalled();
  });
});
