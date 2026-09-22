import { assertNever } from '../../../lib/exhaustive';
import {
  instantOfMonthIndex,
  instantOfYear,
  startOfUtcWeek,
  utcFields,
  utcMonthIndex,
  utcYear,
} from './chart-time';

/**
 * Axes: a domain worth showing, ticks on round values, labels that fit —
 * for numbers first, and for instants below. Pure functions of numbers;
 * nothing here measures the DOM.
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

/**
 * Kill the drift of repeated addition: 0.1 + 0.2 becomes 0.3 at the step's
 * precision. The rounding is by significant digits rather than by decimal
 * places, because `toFixed` takes at most 20 of them: a step of 1e-301 asks
 * for 302, and every tick of such an axis came back as 0.00…0 — one axis
 * labelled 0 all the way along.
 *
 * A tick is a multiple of the step, so the digits between the value's
 * magnitude and the step's are the ones that carry it, plus one to absorb
 * the drift. The tick that should be exactly 0 is the one value that is not
 * a magnitude away from the step, and it arrives as a stray fraction of
 * one; it is snapped back.
 */
function roundTo(value: number, step: number): number {
  if (Math.abs(value) < step * 1e-6) return 0;
  const digits = Math.floor(Math.log10(Math.abs(value))) - Math.floor(Math.log10(step)) + 2;
  return Number(value.toPrecision(Math.min(21, Math.max(1, digits))));
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

/**
 * Time axes. A time axis cannot be the linear one with different labels:
 * its round numbers are calendar boundaries, and the step between them
 * is one of the handful a clock and a calendar actually have — there is
 * no 3.5-hour or 0.4-month tick, and a month is not 30 days.
 */

export type TimeUnit = 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface TimeStep {
  unit: TimeUnit;
  count: number;
}

export interface TimeAxis {
  step: TimeStep;
  ticks: number[];
  labels: string[];
}

const MS: Record<Exclude<TimeUnit, 'month' | 'year'>, number> = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** Only for choosing a step: the mean Gregorian month and year, never used to place a tick. */
const APPROXIMATE = { month: 2_629_746_000, year: 31_556_952_000 };

/**
 * The steps an axis may use, coarsest last. Sub-second steps divide a
 * second, sub-minute ones a minute, and so on up, so every tick of a step
 * is also a boundary of the unit above it; 7 and 14 days are weeks rather
 * than day counts, because that is what makes them fall on the same
 * weekday. Past five years the list continues by ten.
 */
const CANDIDATE_STEPS: readonly TimeStep[] = [
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500].map(count => ({ unit: 'millisecond' as const, count })),
  ...[1, 2, 5, 10, 15, 30].map(count => ({ unit: 'second' as const, count })),
  ...[1, 2, 5, 10, 15, 30].map(count => ({ unit: 'minute' as const, count })),
  ...[1, 2, 3, 6, 12].map(count => ({ unit: 'hour' as const, count })),
  ...[1, 2].map(count => ({ unit: 'day' as const, count })),
  ...[1, 2].map(count => ({ unit: 'week' as const, count })),
  ...[1, 3, 6].map(count => ({ unit: 'month' as const, count })),
  ...[1, 2, 5].map(count => ({ unit: 'year' as const, count })),
];

/** How long a step lasts on average — the question a step is chosen by, not placed by. */
export function approximateStepMs(step: TimeStep): number {
  if (step.unit === 'month' || step.unit === 'year') return step.count * APPROXIMATE[step.unit];
  return step.count * MS[step.unit];
}

const ORDER: TimeUnit[] = ['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'year'];

/**
 * The finest step that covers `span` in at most `targetCount` ticks. A
 * date column passes `day` as its floor: a column of days has nothing to
 * say at 6 p.m., and an axis that ticked there would invent a precision
 * the values do not have.
 */
export function chooseTimeStep(span: number, targetCount: number, floor: TimeUnit = 'millisecond'): TimeStep {
  const target = Math.max(1, targetCount);
  const fits = (step: TimeStep) => !(span > 0) || span / approximateStepMs(step) <= target;
  const from = ORDER.indexOf(floor);
  for (const step of CANDIDATE_STEPS) {
    if (ORDER.indexOf(step.unit) < from) continue;
    if (fits(step)) return step;
  }
  for (let magnitude = 10; magnitude <= 1e9; magnitude *= 10) {
    for (const factor of [1, 2, 5]) {
      const step = { unit: 'year' as const, count: factor * magnitude };
      if (fits(step)) return step;
    }
  }
  // Nothing spans more than ±100,000,000 days, so this is unreachable in practice.
  return { unit: 'year', count: 1e10 };
}

/** The Monday the epoch week began on: weeks are laid out from here, not from the epoch itself. */
const WEEK_ANCHOR = startOfUtcWeek(0);

/**
 * The ticks of `step` inside the domain, in order. Fixed-length steps are
 * counted from the epoch (midnight, and so also the top of every hour and
 * minute it divides), weeks from the Monday of the epoch's week, and
 * months and years from the calendar itself — a step of three months is
 * January, April, July and October, not every 91.3 days.
 */
export function timeTicks(domain: Domain, step: TimeStep): number[] {
  if (!(domain.max > domain.min) || !Number.isFinite(domain.max - domain.min)) return [];
  const ticks: number[] = [];
  const limit = 1000;

  if (step.unit === 'month' || step.unit === 'year') {
    const index = step.unit === 'year' ? utcYear(domain.min) : utcMonthIndex(domain.min);
    const instantOf = step.unit === 'year' ? instantOfYear : instantOfMonthIndex;
    let at = Math.floor(index / step.count) * step.count;
    if ((instantOf(at) ?? -Infinity) < domain.min) at += step.count;
    while (ticks.length < limit) {
      const tick = instantOf(at);
      if (tick === null || tick > domain.max) break;
      ticks.push(tick);
      at += step.count;
    }
    return ticks;
  }

  const size = step.count * MS[step.unit];
  const anchor = step.unit === 'week' ? WEEK_ANCHOR : 0;
  let tick = Math.ceil((domain.min - anchor) / size) * size + anchor;
  while (tick <= domain.max && ticks.length < limit) {
    ticks.push(tick);
    tick += size;
  }
  return ticks;
}

const pad = (value: number, width: number) => String(Math.abs(value)).padStart(width, '0');

/**
 * A year as an axis writes it: four digits, and a sign with as many as it
 * takes outside them — the same spelling the values arrive in.
 */
export function formatYear(year: number): string {
  if (year < 0) return `-${pad(year, 4)}`;
  return year > 9999 ? `+${year}` : pad(year, 4);
}

/** The date of an instant, `YYYY-MM-DD`, which is also a day tick's label. */
export function formatUtcDate(ms: number): string {
  const { year, month, day } = utcFields(ms);
  return `${formatYear(year)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * A tick's label: as much of the instant as the step distinguishes and no
 * more. What the label leaves off the front — the year below a day, the
 * date below an hour — the axis names once beside it rather than on every
 * tick (`timeAxisDates`).
 */
export function formatTimeTick(ms: number, unit: TimeUnit): string {
  const { year, month, day, hour, minute, second, millisecond } = utcFields(ms);
  switch (unit) {
    case 'year': return formatYear(year);
    case 'month': return `${formatYear(year)}-${pad(month, 2)}`;
    case 'week':
    case 'day':
      return formatUtcDate(ms);
    case 'hour':
    case 'minute':
      return `${pad(month, 2)}-${pad(day, 2)} ${pad(hour, 2)}:${pad(minute, 2)}`;
    case 'second': return `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
    case 'millisecond': return `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, 3)}`;
    default: return assertNever(unit, 'time unit');
  }
}

/**
 * The days the axis covers, for the note beside an axis whose labels are
 * clock times: one date when it stays inside a day, the first and the
 * last otherwise. Null above the hour, where every label carries its own
 * date already.
 */
export function timeAxisDates(domain: Domain, unit: TimeUnit): [string] | [string, string] | null {
  if (ORDER.indexOf(unit) > ORDER.indexOf('hour')) return null;
  const first = formatUtcDate(domain.min);
  const last = formatUtcDate(domain.max);
  return first === last ? [first] : [first, last];
}

/**
 * The axis for a span of time: the step it ticks by, the ticks and their
 * labels. `targetCount` is how many ticks the width has room for; the
 * step chosen is the finest that stays inside it.
 */
export function timeAxis(domain: Domain, targetCount: number, floor: TimeUnit = 'millisecond'): TimeAxis {
  const step = chooseTimeStep(domain.max - domain.min, targetCount, floor);
  const ticks = timeTicks(domain, step);
  return { step, ticks, labels: ticks.map(tick => formatTimeTick(tick, step.unit)) };
}

/**
 * Room around a single instant, so a result with one distinct X is a
 * point in the middle of an axis rather than a domain of no width. A day
 * for a date column, a second for a timestamp: the unit the column's own
 * values are counted in.
 */
export function timeDomain(extent: Domain, floor: TimeUnit = 'millisecond'): Domain {
  if (extent.max > extent.min) return extent;
  const half = floor === 'day' ? MS.hour * 12 : MS.second / 2;
  return { min: extent.min - half, max: extent.min + half };
}
