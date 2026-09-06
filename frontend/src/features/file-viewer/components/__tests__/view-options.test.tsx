import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ViewOptions } from '../view-options';

const mockUpdateSettings = vi.fn();
vi.mock('../../../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: { rowsPerPage: 50, typeDisplay: 'logical', rowDensity: 'comfortable' },
    updateSettings: mockUpdateSettings,
  }),
}));

describe('ViewOptions', () => {
  beforeEach(() => mockUpdateSettings.mockClear());

  const open = async () => {
    const user = userEvent.setup();
    render(<ViewOptions buttonClassName="" />);
    await user.click(screen.getByRole('button', { name: 'viewer.viewOptions.title' }));
    return user;
  };

  it('applies the density and the type labels at once', async () => {
    const user = await open();
    expect(screen.getByRole('radio', { name: 'viewer.viewOptions.rowDensityOptions.comfortable' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: 'viewer.viewOptions.rowDensityOptions.compact' }));
    expect(mockUpdateSettings).toHaveBeenCalledWith({ rowDensity: 'compact' });

    await user.click(screen.getByRole('radio', { name: 'viewer.viewOptions.typeDisplayOptions.both' }));
    expect(mockUpdateSettings).toHaveBeenCalledWith({ typeDisplay: 'both' });
  });

  it('closes on Escape and on a click elsewhere, and stays open for its own clicks', async () => {
    const user = await open();
    const dialog = () => screen.queryByRole('dialog', { name: 'viewer.viewOptions.title' });
    expect(dialog()).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'viewer.viewOptions.rowDensityOptions.compact' }));
    expect(dialog()).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog()).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'viewer.viewOptions.title' }));
    expect(dialog()).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(dialog()).not.toBeInTheDocument();
  });
});
