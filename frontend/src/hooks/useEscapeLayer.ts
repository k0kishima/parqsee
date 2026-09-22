import { useEffect, useRef } from 'react';

/**
 * Take Escape while this layer is on screen — a modal, a popover, a context
 * menu — and take it alone.
 *
 * Every layer used to listen for Escape on its own, so one press reached all
 * of them: the Settings dialog opened over the export modal closed both at
 * once, and a popover over the grid closed together with the search bar
 * underneath it. What a person means by Escape is "the thing in front of
 * me", so the layers form a stack and only the last one to open is told.
 *
 * The press is stopped there as well, which is what keeps the layers under
 * it — and the handlers that are not layers at all, the search bar's own
 * Escape among them — from acting on the same press. One listener serves
 * the stack, in the capture phase, so it sees the press before anything
 * closer to the focused element does; it is registered only while a layer
 * is open, so nothing is intercepted while there is none.
 */
type Layer = { current: () => void };

const layers: Layer[] = [];

function dismissTopLayer(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  const top = layers[layers.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  top.current();
}

/**
 * @param active for a layer whose component stays mounted while it is shut
 * — a popover its button renders either way. A layer joins the stack when
 * it opens, so it is in front of what was already there.
 */
export function useEscapeLayer(onEscape: () => void, active = true): void {
  // The layer is registered for as long as it is open, and not once per
  // render: a handler that changes on every render would re-register it and
  // move the layer to the top of the stack in front of one that opened later.
  const layer = useRef(onEscape);
  useEffect(() => {
    layer.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const self = layer;
    layers.push(self);
    if (layers.length === 1) window.addEventListener('keydown', dismissTopLayer, true);
    return () => {
      const index = layers.indexOf(self);
      if (index !== -1) layers.splice(index, 1);
      if (layers.length === 0) window.removeEventListener('keydown', dismissTopLayer, true);
    };
  }, [active]);
}
