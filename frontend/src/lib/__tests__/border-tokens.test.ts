import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Every line the app draws as chrome — a seam between panes, a control's
 * outline, the rules inside a grid — takes its colour from a token, so it
 * is the same line on every screen. Written as a palette class instead, a
 * divider drifts per file and per theme: dark mode had reached three
 * different greys for the same kind of line, one of them lighter than the
 * pane seams and one nearly invisible, before this was tightened up.
 *
 * A colour that is not chrome — a state (focus, error, the drop zone's
 * blue), or a surface repainted over a line to erase it — is not a
 * divider and is listed here by name.
 */
const ALLOWED = [
  // The spinner's arc is a shape, not a divider.
  'features/file-viewer/components/search-bar.tsx',
  // The active tab paints its own background over the tab bar's line.
  'features/layout/components/tab-bar.tsx',
];

const RAW_BORDER = /\S*(?:border|divide)(?:-[a-z])?-(?:gray|slate|zinc|neutral|stone)-\d{2,3}\S*/g;

const SRC = resolve(__dirname, '../..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('border colours', () => {
  it('come from the tokens, not from the palette', () => {
    const offenders = sources(SRC)
      .filter(path => !ALLOWED.some(allowed => path.endsWith(allowed)))
      .flatMap(path => {
        const found = readFileSync(path, 'utf8').match(RAW_BORDER) ?? [];
        return found.map(cls => `${path.slice(SRC.length)}: ${cls}`);
      });
    expect(offenders).toEqual([]);
  });

  it('has a token for each kind of line, in both themes', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    for (const token of ['--border-primary', '--border-secondary', '--border-subtle']) {
      // Once under `:root` and once under `.dark`.
      expect(css.split(`${token}:`).length - 1, token).toBe(2);
      expect(css).toContain(`border-color: var(${token})`);
    }
  });
});
