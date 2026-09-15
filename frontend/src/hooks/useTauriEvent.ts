import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../lib/tauri';

/**
 * Subscribe to a Tauri event for as long as the component lives, and report
 * whether the subscription is in place.
 *
 * The listener is registered exactly once and reads `handler` through a ref,
 * because re-registering on every new callback left the old and the new
 * listener overlapping — `listen` resolves before the previous `unlisten`
 * does — and a menu item picked in that window ran twice, while a file
 * Finder handed over in it was lost.
 *
 * The returned flag is false until `listen` has resolved, for the caller
 * that must not let the backend start emitting before the listener exists
 * (the launch-time handover in `WorkspaceProvider`). Outside Tauri nothing
 * is registered and the flag is true, since no event will ever arrive.
 */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void): boolean {
    const current = useRef(handler);
    useEffect(() => {
        current.current = handler;
    }, [handler]);

    const [ready, setReady] = useState(!isTauri());
    useEffect(() => {
        if (!isTauri()) return;
        // The rejection is caught here, not at each use of `listening`: the
        // promise is awaited twice — once to report the subscription ready,
        // once to undo it — and a `listen` that fails would otherwise raise
        // an unhandled rejection at each, saying nothing about which event
        // went unheard. Nothing is marked ready, so a caller waiting on the
        // subscription keeps waiting rather than letting the backend emit
        // into a listener that does not exist.
        const listening = listen<T>(event, e => current.current(e.payload)).catch(error => {
            console.error(`Failed to listen for ${event}:`, error);
            return null;
        });
        listening.then(unlisten => unlisten && setReady(true));
        return () => {
            listening.then(unlisten => unlisten?.());
        };
    }, [event]);

    return ready;
}
