import type { ExclusionReason } from './chart-types';

/**
 * Instants on a time axis: the strings a date or timestamp column arrives
 * as, turned into milliseconds since the epoch.
 *
 * The parsing is deliberately its own, rather than `Date.parse`: that
 * accepts whatever the engine feels like (`'2024-13-45'`, `'March 3'`),
 * reads a bare date-time as *local* time in some browsers, and rolls
 * February 30th over into March instead of refusing it. A chart that
 * placed a point a month away from the value in the table would be wrong
 * in a way nothing on screen could reveal, so every field is checked and
 * anything unrecognized is counted as an excluded point instead.
 *
 * The shapes accepted are the ones the backend actually writes, pinned
 * from the arrow JSON writer in `contracts/temporal-wire-cases.json`: a
 * bare `YYYY-MM-DD`, a date-time with zero to nine fraction digits, and
 * either `Z`, a numeric `±HH:MM` offset (a named zone is resolved to its
 * offset for that instant before it reaches us) or nothing at all. A year
 * outside the epoch's four digits carries a sign and up to six.
 */

/** A parsed instant, or why the cell has none. */
export type ParsedInstant =
  | { ok: true; value: number; subMillisecond: boolean }
  | { ok: false; reason: ExclusionReason };

/** The largest absolute instant a JS date holds: ±100,000,000 days. */
export const MAX_INSTANT = 8.64e15;

const DATE = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^([+-]?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;

const MISSING: ParsedInstant = { ok: false, reason: 'missing' };
const INVALID: ParsedInstant = { ok: false, reason: 'invalid' };
/** A well-formed instant a JS date cannot hold; the table still has it exactly. */
const PRECISION: ParsedInstant = { ok: false, reason: 'precision' };

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The length of `month` (1-12) in `year`, in the proleptic Gregorian calendar the writer uses. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  return month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1];
}

/** Whether the fields name a day that exists: `2024-02-30` does not. */
const isCalendarDate = (year: number, month: number, day: number) =>
  day >= 1 && day <= daysInMonth(year, month);

/** Whether the fields name a time of day. A leap second is not one — no writer emits it. */
const isClockTime = (hour: number, minute: number, second: number) =>
  hour <= 23 && minute <= 59 && second <= 59;

/**
 * The instant of a UTC date and time, or null when a JS date cannot hold
 * it. The date is built field by field rather than from a string so that
 * a year between 0 and 99 stays itself — `Date.UTC(99, 0, 1)` is 1999, a
 * remapping `setUTCFullYear` does not make. Fields that do not name a day
 * are refused rather than rolled over into the next month, so callers
 * check them with `isCalendarDate` first and get null here only for an
 * instant outside the ±100,000,000 days a date spans.
 */
export function utcInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number | null {
  if (!isCalendarDate(year, month, day) || !isClockTime(hour, minute, second)) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  const value = date.getTime();
  return Number.isFinite(value) ? value : null;
}

/**
 * The milliseconds of a fraction-of-a-second, and whether digits finer
 * than a millisecond were dropped to get there. Time is truncated, never
 * rounded: a point must not move to the next millisecond, let alone the
 * next second, and truncating the written digits keeps the order of two
 * instants whichever side of the epoch they fall.
 */
function fractionMilliseconds(fraction: string | undefined): { ms: number; subMillisecond: boolean } {
  if (!fraction) return { ms: 0, subMillisecond: false };
  const ms = Number(fraction.slice(0, 3).padEnd(3, '0'));
  return { ms, subMillisecond: /[1-9]/.test(fraction.slice(3)) };
}

/** Minutes east of UTC for `Z` or `±HH:MM`, or null when the offset is not one. */
function offsetMinutes(offset: string | undefined): number | null {
  if (!offset || offset === 'Z') return 0;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) return null;
  return (offset[0] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/** A date column's `YYYY-MM-DD`, placed at midnight UTC — no time zone is applied to a day. */
export function parseDateValue(raw: unknown): ParsedInstant {
  if (raw === null || raw === undefined) return MISSING;
  if (typeof raw !== 'string') return INVALID;
  const match = DATE.exec(raw);
  if (!match) return INVALID;
  const [year, month, day] = match.slice(1).map(Number);
  if (!isCalendarDate(year, month, day)) return INVALID;
  const value = utcInstant(year, month, day);
  return value === null ? PRECISION : { ok: true, value, subMillisecond: false };
}

/**
 * A timestamp column's date-time. With `Z` or an offset it names an
 * instant and the axis is UTC. Without one the column has no zone at all,
 * and the wall clock is placed in UTC rather than in the machine's zone:
 * the same query must draw the same chart in Tokyo and in Berlin, and a
 * column that does not say where its clock stood cannot be moved to one.
 */
export function parseTimestampValue(raw: unknown): ParsedInstant {
  if (raw === null || raw === undefined) return MISSING;
  if (typeof raw !== 'string') return INVALID;
  const match = TIMESTAMP.exec(raw);
  if (!match) return INVALID;
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  if (!isCalendarDate(y, mo, d) || !isClockTime(h, mi, s)) return INVALID;
  const { ms, subMillisecond } = fractionMilliseconds(fraction);
  const minutesEast = offsetMinutes(offset);
  if (minutesEast === null) return INVALID;
  const wall = utcInstant(y, mo, d, h, mi, s, ms);
  if (wall === null) return PRECISION;
  const value = wall - minutesEast * 60_000;
  if (!Number.isFinite(value) || Math.abs(value) > MAX_INSTANT) return PRECISION;
  return { ok: true, value, subMillisecond };
}

/**
 * The UTC calendar, as the tick generator needs it. Months and years are
 * addressed by index rather than by duration: stepping a chart's axis by
 * "one month" has to land on the first of the next month, and a fixed 30
 * days walks off the calendar within a year.
 */

const DAY_MS = 86_400_000;

/** The month `ms` falls in, counted from January of year 0. */
export const utcMonthIndex = (ms: number): number => {
  const date = new Date(ms);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};

/** Midnight on the first of the month `index` names, or null when a date cannot hold it. */
export function instantOfMonthIndex(index: number): number | null {
  const year = Math.floor(index / 12);
  return utcInstant(year, index - year * 12 + 1, 1);
}

export const utcYear = (ms: number): number => new Date(ms).getUTCFullYear();

/** Midnight on the first of January, or null when a date cannot hold it. */
export const instantOfYear = (year: number): number | null => utcInstant(year, 1, 1);

/** Midnight of the day `ms` falls in. */
const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * Midnight of the Monday of the week `ms` falls in. Weeks start on Monday
 * rather than on the epoch's own Thursday, which is what a week means on
 * an axis; ISO and both of the app's locales agree on it.
 */
export function startOfUtcWeek(ms: number): number {
  const day = startOfUtcDay(ms);
  const fromMonday = (new Date(day).getUTCDay() + 6) % 7;
  return day - fromMonday * DAY_MS;
}

/** The UTC fields of an instant, for an axis label. */
export function utcFields(ms: number) {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}
