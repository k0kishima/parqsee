import { useEffect } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

type KeydownTarget = 'window' | 'document';

/**
 * Register a keydown listener for the lifetime of the component.
 *
 * The handler is re-registered whenever it changes, so callers should keep it
 * stable (useCallback) or accept that the listener is swapped on each render.
 */
export function useGlobalKeydown(
  handler: (event: KeyboardEvent) => void,
  target: KeydownTarget = 'window'
): void {
  useEffect(() => {
    const element = target === 'window' ? window : document;
    element.addEventListener('keydown', handler as EventListener);
    return () => element.removeEventListener('keydown', handler as EventListener);
  }, [handler, target]);
}

/** True for Cmd on macOS or Ctrl elsewhere. */
export function isModifierPressed(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}
