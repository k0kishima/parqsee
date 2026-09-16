/**
 * Numeric axes: a domain worth showing, ticks on round values, labels that
 * fit. Pure functions of numbers — nothing here measures the DOM.
 */

export interface Domain {
  min: number;
  max: number;
}

export interface LinearScale {
  domain: Domain;
  range: [number, number];
  (value: number): number;
}

/**
 * Round the extent of a bar chart's values out to include zero — a bar is
 * a length from the baseline, so the baseline has to be on the axis — and
 * give a degenerate extent some room: all zeros become [0, 1], a single
 * non-zero value gets 5% either side.
 */
export function barDomain(extent: Domain): Domain {
  let min = Math.min(0, extent.min);
  let max = Math.max(0, extent.max);
  if (min === max) return min === 0 ? { min: 0, max: 1 } : padConstant(min);
  return { min, max };
}

/**
 * The extent of a line or scatter chart with 5% of head-room on each side.
 * Zero is not forced in: a series between 1,000 and 1,010 would be a flat
 * line at the top of the plot otherwise.
 */
export function paddedDomain(extent: Domain): Domain {
  if (extent.min === extent.max) return extent.min === 0 ? { min: -1, max: 1 } : padConstant(extent.min);
  const pad = (extent.max - extent.min) * 0.05;
  return { min: extent.min - pad, max: extent.max + pad };
}

function padConstant(value: number): Domain {
  const pad = Math.abs(value) * 0.05;
  const min = Math.min(value - pad, value);
  const max = Math.max(value + pad, value);
  // A sub-normal value loses its 5% to rounding; step out by the smallest double then.
  if (min === max) return { min: value - Number.MIN_VALUE, max: value + Number.MIN_VALUE };
  return { min, max };
}

export function linearScale(domain: Domain, range: [number, number]): LinearScale {
  const span = domain.max - domain.min;
  const scale = ((value: number) => range[0] + ((value - domain.min) / span) * (range[1] - range[0])) as LinearScale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/**
 * Ticks at 1, 2 or 5 × 10^k inside the domain, about `count` of them.
 * Listed from the first multiple at or above the minimum, so no tick lies
 * outside the axis; the domain's own ends are not ticks unless they are
 * round.
 */
export function linearTicks(domain: Domain, count: number): number[] {
  const span = domain.max - domain.min;
  if (!(span > 0) || !Number.isFinite(span) || count < 1) return [];
  const step = niceStep(span / count);
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const first = Math.ceil(domain.min / step) * step;
  const ticks: number[] = [];
  for (let i = 0; ; i++) {
    const tick = roundTo(first + i * step, step);
    if (tick > domain.max + step * 1e-9) break;
    if (ticks.length > count * 3) break;
    ticks.push(tick === 0 ? 0 : tick);
  }
  return ticks;
}

/** The 1 / 2 / 5 × 10^k step nearest to `rough` from above. */
export function niceStep(rough: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const ratio = rough / power;
  const factor = ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10;
  return factor * power;
}

/** Kill the drift of repeated addition: 0.1 + 0.2 becomes 0.3 at the step's precision. */
function roundTo(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(value.toFixed(Math.min(decimals, 20)));
}

const SUFFIXES: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];

/**
 * An axis label: three significant digits with a k / M / B / T suffix,
 * exponent notation past 10^15 and below 10^-3, the locale's digits and
 * separators. Both languages use the same suffixes — 万 / 億 would make
 * the two builds disagree on where the axis breaks.
 */
export function formatTick(value: number, locale: string, digits = 3): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e15 || abs < 1e-3) return value.toExponential(Math.max(0, digits - 1)).replace(/\.?0+e/, 'e');
  for (const [unit, suffix] of SUFFIXES) {
    if (abs >= unit) return significant(value / unit, locale, digits) + suffix;
  }
  return significant(value, locale, digits);
}

function significant(value: number, locale: string, digits: number): string {
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: Math.min(21, Math.max(1, digits)) }).format(value);
}

/**
 * Labels for a set of ticks, distinct from their neighbours: when two
 * round to the same text the precision grows (to 17 digits at most), and
 * if even that does not tell them apart every other tick is dropped.
 */
export function tickLabels(ticks: number[], locale: string): { ticks: number[]; labels: string[] } {
  let current = ticks;
  for (;;) {
    for (let digits = 3; digits <= 17; digits++) {
      const labels = current.map(t => formatTick(t, locale, digits));
      if (new Set(labels).size === labels.length) return { ticks: current, labels };
    }
    if (current.length <= 1) return { ticks: current, labels: current.map(t => formatTick(t, locale)) };
    current = current.filter((_, i) => i % 2 === 0);
  }
}
