import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropZone } from '../drop-zone';

// test/setup.ts mocks react-i18next with the key as the fallback text.
describe('DropZone', () => {
  it('offers the sample file next to the ways to open one\'s own', async () => {
    const onOpenSample = vi.fn();
    const onBrowse = vi.fn();
    const onOpenFolder = vi.fn();
    render(<DropZone onFileSelect={vi.fn()} onBrowse={onBrowse} onOpenFolder={onOpenFolder} onOpenSample={onOpenSample} />);

    await userEvent.click(screen.getByRole('button', { name: 'welcome.dropZone.openSample' }));

    expect(onOpenSample).toHaveBeenCalledTimes(1);
    expect(onBrowse).not.toHaveBeenCalled();
    expect(onOpenFolder).not.toHaveBeenCalled();
  });
});
