/** How many series colors `index.css` defines before they wrap around. */
export const SERIES_COLOR_COUNT = 8;

/**
 * The color of series `ordinal` (0-based, column order). Colors follow
 * the column, not a hash of its name: the same query gives the same
 * colors on every run, and a reordered SELECT visibly reorders them.
 * Past eight the colors repeat; the legend's numbers keep the series apart.
 */
export const seriesColor = (ordinal: number) => `var(--chart-series-${(ordinal % SERIES_COLOR_COUNT) + 1})`;
