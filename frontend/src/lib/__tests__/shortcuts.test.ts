import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SHORTCUTS,
  SHORTCUT_SECTIONS,
  shortcutKeys,
  withShortcut,
  matchShortcut,
  matchGoToTab,
} from '../shortcuts';
import en from '../../locales/en.json';
import ja from '../../locales/ja.json';

const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, code: '', ...init }) as KeyboardEvent;

describe('the shortcut table', () => {
  it('has unique ids in known sections', () => {
    const ids = SHORTCUTS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const shortcut of SHORTCUTS) {
      expect(SHORTCUT_SECTIONS).toContain(shortcut.section);
      expect(shortcut.keys.length).toBeGreaterThan(0);
    }
  });

  it('has a label in both languages for every shortcut and section', () => {
    for (const locale of [en, ja]) {
      const labels = locale.shortcuts as Record<string, unknown>;
      for (const shortcut of SHORTCUTS) expect(labels[shortcut.id], shortcut.id).toEqual(expect.any(String));
      for (const section of SHORTCUT_SECTIONS) {
        expect((labels.sections as Record<string, unknown>)[section], section).toEqual(expect.any(String));
      }
    }
  });

  it('formats the keys with their alternatives', () => {
    expect(shortcutKeys('open-folder')).toBe('⇧⌘O');
    expect(shortcutKeys('next-tab')).toBe('⇧⌘] / ⌥⌘→');
    expect(withShortcut('Open File', 'open-file')).toBe('Open File (⌘O)');
  });
});

describe('the native menu', () => {
  const rust = (path: string) => readFileSync(resolve(__dirname, '../../../../backend/src', path), 'utf8');
  const buildMenu = rust('lib.rs');
  // `b.item("<id>", Some("<accelerator>"))`; the label is looked up from
  // the id in `services::menu_labels`, which is why it is not here.
  const items = [...buildMenu.matchAll(/b\.item\("([^"]+)", Some\("([^"]+)"\)\)/g)]
    .map(([, id, accelerator]) => ({ id, accelerator }));

  /** muda's accelerator syntax as the glyphs the menu bar shows for it. */
  const glyphs = (accelerator: string) => {
    const parts = accelerator.split('+');
    const modifiers = { Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', CmdOrCtrl: '⌘', Cmd: '⌘', Super: '⌘' } as const;
    const keys = { Enter: '↩', Slash: '/', BracketLeft: '[', BracketRight: ']', Comma: ',' } as const;
    const order = ['⌃', '⌥', '⇧', '⌘'];
    const mods = parts.slice(0, -1).map(p => modifiers[p as keyof typeof modifiers]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const last = parts[parts.length - 1];
    return mods.join('') + (keys[last as keyof typeof keys] ?? last.toUpperCase());
  };

  it('is read from lib.rs', () => {
    expect(items.map(i => i.id)).toContain('open-file');
  });

  it('carries the same keys as the table for every item with an accelerator', () => {
    for (const { id, accelerator } of items) {
      const shortcut = SHORTCUTS.find(s => s.id === id);
      expect(shortcut, `menu item ${id} is not in SHORTCUTS`).toBeDefined();
      expect(glyphs(accelerator), id).toBe(shortcut!.keys[0]);
    }
  });

  // The menu's labels are in Rust, not in `locales/` — the menu bar is the
  // one surface the webview cannot draw, and it has to be right before the
  // webview exists (see `services::menu_labels`). A key with no entry
  // there falls back to the key itself, which would put `toggle-sidebar`
  // in the menu bar rather than failing, so it is checked here.
  it('labels every item from a key the Rust tables have', () => {
    const keys = [...rust('services/menu_labels.rs')
      .slice(0, rust('services/menu_labels.rs').indexOf('const EN'))
      .matchAll(/^ {4}"([^"]+)",$/gm)].map(([, key]) => key);
    expect(keys).toContain('open-file');

    const used = [...buildMenu.matchAll(/b\.(?:item|predefined|submenu)\(\s*"([^"]+)"/g)].map(([, key]) => key);
    expect(used.length).toBeGreaterThan(items.length);
    for (const key of used) expect(keys, `${key} has no label`).toContain(key);
  });
});

describe('matchShortcut', () => {
  it('tells ⌘O from ⇧⌘O and accepts Ctrl for ⌘', () => {
    expect(matchShortcut(key({ metaKey: true, key: 'o' }))).toBe('open-file');
    expect(matchShortcut(key({ metaKey: true, shiftKey: true, key: 'O' }))).toBe('open-folder');
    expect(matchShortcut(key({ ctrlKey: true, key: 'f' }))).toBe('find');
    expect(matchShortcut(key({ key: 'o' }))).toBeNull();
  });

  it('matches the bracket keys by code, whatever ⇧ makes of them', () => {
    expect(matchShortcut(key({ metaKey: true, shiftKey: true, key: '}', code: 'BracketRight' }))).toBe('next-tab');
    expect(matchShortcut(key({ metaKey: true, altKey: true, key: 'ArrowLeft' }))).toBe('previous-tab');
  });

  it('reads the tab number off ⌘1 … ⌘9 only', () => {
    expect(matchGoToTab(key({ metaKey: true, key: '3' }))).toBe(3);
    expect(matchGoToTab(key({ metaKey: true, key: '0' }))).toBeNull();
    expect(matchGoToTab(key({ metaKey: true, shiftKey: true, key: '3' }))).toBeNull();
    expect(matchGoToTab(key({ key: '3' }))).toBeNull();
  });
});
