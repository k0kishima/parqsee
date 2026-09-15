import { revealItemInDir } from '@tauri-apps/plugin-opener';

/**
 * Put `path` on the clipboard, reporting whether it got there so a caller
 * can confirm it in the UI.
 *
 * Both of these fail for reasons the user cannot act on — no clipboard
 * permission, a path Finder will not select — and neither is worth
 * interrupting them for, so a failure is logged and the surface stays as it
 * was. Keeping that decision in one place is the point: three menus made it
 * separately, down to the wording of the log line.
 */
export async function copyPath(path: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(path);
        return true;
    } catch (error) {
        console.error('Failed to copy path:', error);
        return false;
    }
}

/** Select `path` in Finder. See `copyPath` for why a failure only logs. */
export async function revealInFinder(path: string): Promise<void> {
    try {
        await revealItemInDir(path);
    } catch (error) {
        console.error('Failed to reveal in Finder:', error);
    }
}
