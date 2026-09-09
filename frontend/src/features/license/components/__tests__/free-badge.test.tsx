import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FreeBadge } from '../free-badge';
import { FREE_TAB_LIMIT } from '../../lib/license';

const license = vi.hoisted(() => ({ unlocked: false, showUpgrade: vi.fn() }));
vi.mock('../../../../contexts/LicenseContext', () => ({ useLicense: () => license }));

describe('FreeBadge', () => {
  beforeEach(() => {
    license.unlocked = false;
    license.showUpgrade.mockClear();
  });

  it('is one button that names the version and the limit, and opens the upgrade prompt', async () => {
    render(<FreeBadge />);

    const badge = screen.getByTestId('free-badge');
    expect(badge.tagName).toBe('BUTTON');
    expect(badge).toHaveTextContent('license.badge.free');
    // The limit is in the tooltip, not in the row.
    expect(badge).toHaveAttribute('title', `license.badge.tooltip`.replace('{{count}}', String(FREE_TAB_LIMIT)));
    expect(badge).not.toHaveTextContent('license.upgradeLink');

    await userEvent.click(badge);
    expect(license.showUpgrade).toHaveBeenCalledTimes(1);
  });

  it('renders nothing once the full version is owned', () => {
    license.unlocked = true;
    render(<FreeBadge />);
    expect(screen.queryByTestId('free-badge')).not.toBeInTheDocument();
  });
});
