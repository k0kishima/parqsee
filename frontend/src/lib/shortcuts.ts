import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Every keyboard shortcut the app answers to, in one place.
 *
 * The native menu (`build_menu` in `lib.rs`) carries the same ids with the
 * same keys — `lib/__tests__/shortcuts.test.ts` reads that file and checks
 * — and the cheat sheet, the tooltips and the context menus draw their key
 * labels from here, so a key is never written differently in two places.
 *
 * Keys are macOS glyphs in the menu bar's own order (⌃ ⌥ ⇧ ⌘), which is
 * what the menu shows next to the same item. Off the Mac the keydown
 * fallbacks accept Ctrl for ⌘, but the labels are not translated for them:
 * the app ships on macOS.
 *
 * On macOS a native key equivalent wins over the webview's keydown, so a
 * shortcut that is in the menu reaches the webview as a `menu` event and
 * its `match` never fires there; `match` is the fallback for the rest.
 */
export type ShortcutId =
    | 'open-file'
    | 'open-folder'
    | 'settings'
    | 'close-tab'
    | 'reopen-tab'
    | 'next-tab'
    | 'previous-tab'
    | 'go-to-tab'
    | 'toggle-sidebar'
    | 'switch-view'
    | 'refresh'
    | 'shortcuts'
    | 'find'
    | 'find-next'
    | 'find-previous'
    | 'close-search'
    | 'run-query'
    | 'stop-query';

export type ShortcutSection = 'files' | 'tabs' | 'view' | 'search' | 'query';

export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = ['files', 'tabs', 'view', 'search', 'query'];

type KeyEvent = KeyboardEvent | ReactKeyboardEvent;

export interface Shortcut {
    id: ShortcutId;
    section: ShortcutSection;
    /** The key, then any alternatives: `['⇧⌘]', '⌥⌘→']`. */
    keys: readonly string[];
    /**
     * Whether a keydown is this shortcut, for the webview's own handling.
     * Absent for keys that only mean something inside a control (Enter in
     * the search box, Escape) and for ⌘1…9, which carries a number.
     */
    match?: (event: KeyEvent) => boolean;
}

/**
 * Whether the webview is on a Mac, read per keydown so a test can stand
 * on either side. WKWebView's user agent names the platform `Macintosh`;
 * jsdom's names it `darwin`, and does not count.
 */
const onMac = () => /Macintosh/.test(navigator.userAgent);

/**
 * ⌘ on macOS, Ctrl elsewhere. On a Mac ⌃ is never a shortcut modifier:
 * every text field answers the Emacs keys — ⌃E to the end of the line,
 * ⌃B and ⌃F a character back and forward, ⌃O to open a line — and a
 * ⌘ shortcut that also matched Ctrl swallowed them, so ⌃E in the SQL
 * editor switched the view instead of moving the caret.
 */
const mod = (e: KeyEvent) => (onMac() ? e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey);
const letter = (e: KeyEvent, key: string, shift = false) =>
    mod(e) && e.shiftKey === shift && !e.altKey && e.key.toLowerCase() === key;

export const SHORTCUTS: readonly Shortcut[] = [
    { id: 'open-file', section: 'files', keys: ['⌘O'], match: e => letter(e, 'o') },
    { id: 'open-folder', section: 'files', keys: ['⇧⌘O'], match: e => letter(e, 'o', true) },
    { id: 'settings', section: 'files', keys: ['⌘,'], match: e => mod(e) && e.key === ',' },

    { id: 'close-tab', section: 'tabs', keys: ['⌘W'], match: e => letter(e, 'w') },
    { id: 'reopen-tab', section: 'tabs', keys: ['⇧⌘T'], match: e => letter(e, 't', true) },
    // `code`, not `key`: with ⇧ held the key reads `}` on a US layout.
    { id: 'next-tab', section: 'tabs', keys: ['⇧⌘]', '⌥⌘→'], match: e =>
        (mod(e) && e.shiftKey && e.code === 'BracketRight') || (mod(e) && e.altKey && e.key === 'ArrowRight') },
    { id: 'previous-tab', section: 'tabs', keys: ['⇧⌘[', '⌥⌘←'], match: e =>
        (mod(e) && e.shiftKey && e.code === 'BracketLeft') || (mod(e) && e.altKey && e.key === 'ArrowLeft') },
    { id: 'go-to-tab', section: 'tabs', keys: ['⌘1 … ⌘9'] },

    { id: 'toggle-sidebar', section: 'view', keys: ['⌘B'], match: e => letter(e, 'b') },
    { id: 'switch-view', section: 'view', keys: ['⌘E'], match: e => letter(e, 'e') },
    { id: 'refresh', section: 'view', keys: ['⌘R'], match: e => letter(e, 'r') },
    { id: 'shortcuts', section: 'view', keys: ['⌘/'], match: e => mod(e) && e.key === '/' },

    { id: 'find', section: 'search', keys: ['⌘F'], match: e => letter(e, 'f') },
    { id: 'find-next', section: 'search', keys: ['⌘G', '↩'], match: e => letter(e, 'g') },
    { id: 'find-previous', section: 'search', keys: ['⇧⌘G', '⇧↩'], match: e => letter(e, 'g', true) },
    { id: 'close-search', section: 'search', keys: ['Esc'] },

    { id: 'run-query', section: 'query', keys: ['⌘↩'], match: e => mod(e) && e.key === 'Enter' },
    { id: 'stop-query', section: 'query', keys: ['⌘.'], match: e => mod(e) && e.key === '.' },
];

const byId = new Map(SHORTCUTS.map(shortcut => [shortcut.id, shortcut]));

/** The shortcut's keys as shown beside a label: the alternatives joined. */
export function shortcutKeys(id: ShortcutId): string {
    const shortcut = byId.get(id);
    if (!shortcut) throw new Error(`unknown shortcut: ${id}`);
    return shortcut.keys.join(' / ');
}

/** `label (keys)`, for a tooltip. */
export const withShortcut = (label: string, id: ShortcutId): string => `${label} (${shortcutKeys(id)})`;

/** The first shortcut a keydown matches, if any. */
export function matchShortcut(event: KeyEvent): ShortcutId | null {
    return SHORTCUTS.find(shortcut => shortcut.match?.(event))?.id ?? null;
}

/** The tab number ⌘1 … ⌘9 asks for, or null for any other key. */
export function matchGoToTab(event: KeyEvent): number | null {
    if (!mod(event) || event.shiftKey || event.altKey) return null;
    return /^[1-9]$/.test(event.key) ? parseInt(event.key, 10) : null;
}
