/** How many series colors `index.css` defines before they wrap around. */
export const SERIES_COLOR_COUNT = 8;

/**
 * The color of series `ordinal` (0-based, column order). Colors follow
 * the column, not a hash of its name: the same query gives the same
 * colors on every run, and a reordered SELECT visibly reorders them.
 * Past eight the colors repeat; the legend's numbers keep the series apart.
 */
export const seriesColor = (ordinal: number) => `var(--chart-series-${(ordinal % SERIES_COLOR_COUNT) + 1})`;

/**
 * How many dash patterns there are before they repeat. Four, against
 * eight colors: the dash is a second signal for a reader who cannot rely
 * on the first, not a second identity — the legend's numbers are what
 * tell two series apart for certain.
 */
export const SERIES_DASH_COUNT = 4;

const DASHES = [undefined, '8 3', '2 3', '8 3 2 3'];

/** The `stroke-dasharray` of series `ordinal`, or undefined for a solid line. */
export const seriesDash = (ordinal: number) => DASHES[ordinal % SERIES_DASH_COUNT];

/** How many mark shapes there are before they repeat. */
export const SERIES_SYMBOL_COUNT = 4;

/**
 * The shapes a scatter's marks take, by series. Like the dash on a line,
 * the shape doubles the colour rather than replacing it: colour is read
 * faster, and a shape carries where colour cannot — in a print-out, for a
 * colour-blind reader, and where two series overlap and the fills mix.
 */
export type SeriesSymbol = 'circle' | 'square' | 'triangle' | 'diamond';

const SYMBOLS: SeriesSymbol[] = ['circle', 'square', 'triangle', 'diamond'];

export const seriesSymbol = (ordinal: number): SeriesSymbol => SYMBOLS[ordinal % SERIES_SYMBOL_COUNT];
