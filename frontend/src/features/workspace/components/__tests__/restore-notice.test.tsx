import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RestoreNotice } from '../restore-notice';

describe('RestoreNotice', () => {
  it('names the files that could not be reopened', () => {
    render(<RestoreNotice skipped={['/data/a.parquet', '/data/b.parquet']} capped={[]} onDismiss={vi.fn()} onUpgrade={vi.fn()} />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('session.notReopened');
    expect(notice).toHaveTextContent('a.parquet, b.parquet');
    expect(screen.queryByTestId('restore-notice-capped')).not.toBeInTheDocument();
  });

  it('names the tabs the free tier left out, with the way to the full version', async () => {
    const onUpgrade = vi.fn();
    render(<RestoreNotice skipped={[]} capped={['/data/fourth.parquet']} onDismiss={vi.fn()} onUpgrade={onUpgrade} />);

    const capped = screen.getByTestId('restore-notice-capped');
    expect(capped).toHaveTextContent('session.notRestoredFree');
    expect(capped).toHaveTextContent('fourth.parquet');

    await userEvent.click(screen.getByRole('button', { name: 'license.upgradeLink' }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it('is dismissed from its ✕', async () => {
    const onDismiss = vi.fn();
    render(<RestoreNotice skipped={['/data/a.parquet']} capped={[]} onDismiss={onDismiss} onUpgrade={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
