import { afterAll, beforeAll, vi } from 'vitest';

/**
 * Give the charts a plot to draw in. jsdom has no ResizeObserver, and
 * `useElementSize` is the only thing that tells a chart how big it is — an
 * unstubbed test measures nothing and renders an empty SVG, whatever the
 * data says. The size is a plausible plot, not a real layout: jsdom lays
 * nothing out, so a real observer would report zero here too.
 */
class FakeResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe() { this.callback([{ contentRect: { width: 600, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}

/** Call at the top level of a test file whose components measure themselves. */
export function stubResizeObserver() {
  beforeAll(() => { vi.stubGlobal('ResizeObserver', FakeResizeObserver); });
  afterAll(() => { vi.unstubAllGlobals(); });
}
