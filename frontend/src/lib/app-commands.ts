import { useEffect } from 'react';
import type { ShortcutId } from './shortcuts';

/**
 * Commands that belong to a view rather than to the workspace: what ⌘F
 * means depends on which tab is showing and whether it is on the grid or
 * the SQL editor. The workspace context receives them — from the native
 * menu as a `menu` event, or from its keydown fallback — and hands them on
 * here; the view that is active answers, the rest ignore them.
 *
 * Every one of them is a `ShortcutId`, and `satisfies` is what says so:
 * the list is the subset of the shortcuts that a view answers rather than
 * a second spelling of them, and a name misspelt here would otherwise be
 * a command that simply never arrives.
 */
export const APP_COMMANDS = ['find', 'find-next', 'find-previous', 'run-query', 'stop-query', 'switch-view'] as const satisfies readonly ShortcutId[];

export type AppCommand = typeof APP_COMMANDS[number];

export const isAppCommand = (id: string): id is AppCommand =>
    (APP_COMMANDS as readonly string[]).includes(id);

const EVENT = 'app-command';
const bus = new EventTarget();

export function dispatchAppCommand(command: AppCommand): void {
    bus.dispatchEvent(new CustomEvent<AppCommand>(EVENT, { detail: command }));
}

/** Answer app commands for the lifetime of the component. */
export function useAppCommand(handler: (command: AppCommand) => void): void {
    useEffect(() => {
        const listener = (event: Event) => handler((event as CustomEvent<AppCommand>).detail);
        bus.addEventListener(EVENT, listener);
        return () => bus.removeEventListener(EVENT, listener);
    }, [handler]);
}
