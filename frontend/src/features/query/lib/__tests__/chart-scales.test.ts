import { describe, it, expect } from 'vitest';
import {
  barDomain,
  chooseTimeStep,
  formatTick,
  formatTimeTick,
  formatYear,
  linearScale,
  linearTicks,
  niceStep,
  paddedDomain,
  tickLabels,
  timeAxisDates,
  timeDomain,
  timeTicks,
} from '../chart-scales';

describe('domains', () => {
  it('always puts zero on a bar axis and gives degenerate extents room', () => {
    expect(barDomain({ min: 3, max: 10 })).toEqual({ min: 0, max: 10 });
    expect(barDomain({ min: -4, max: -1 })).toEqual({ min: -4, max: 0 });
    expect(barDomain({ min: 0, max: 0 })).toEqual({ min: 0, max: 1 });
    expect(barDomain({ min: 5, max: 5 })).toEqual({ min: 0, max: 5 });
  });

  it('pads a line domain by 5% without forcing zero in', () => {
    expect(paddedDomain({ min: 1000, max: 1010 })).toEqual({ min: 999.5, max: 1010.5 });
    expect(paddedDomain({ min: 0, max: 0 })).toEqual({ min: -1, max: 1 });
    const constant = paddedDomain({ min: 40, max: 40 });
    expect(constant.min).toBeCloseTo(38);
    expect(constant.max).toBeCloseTo(42);
    const tiny = paddedDomain({ min: 5e-324, max: 5e-324 });
    expect(tiny.min).toBeLessThan(tiny.max);
  });
});

describe('ticks', () => {
  it('steps by 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(0.3)).toBe(0.5);
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.5)).toBe(2);
    expect(niceStep(37)).toBe(50);
    expect(niceStep(600)).toBe(1000);
  });

  it('keeps every tick inside the domain and free of float drift', () => {
    expect(linearTicks({ min: 0, max: 10 }, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(linearTicks({ min: -3, max: 7 }, 5)).toEqual([-2, 0, 2, 4, 6]);
    expect(linearTicks({ min: 0, max: 1 }, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(linearTicks({ min: 0.1, max: 0.35 }, 5)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    expect(linearTicks({ min: 0, max: 0 }, 5)).toEqual([]);
    expect(linearTicks({ min: -5e307, max: 5e307 }, 4)).toEqual([-5e307, 0, 5e307]);
    // A span that overflows has no ticks; the model refuses such data as unsafeRange first.
    expect(linearTicks({ min: -1e308, max: 1e308 }, 4)).toEqual([]);
  });

  it('ticks a domain whose step is finer than a fixed-point rounding can write', () => {
    // toFixed takes at most 20 decimal places, so a step of 1e-301 rounded
    // every tick of this axis to 0.
    expect(linearTicks({ min: 0, max: 2e-300 }, 4)).toEqual([0, 5e-301, 1e-300, 1.5e-300, 2e-300]);
  });

  it('maps a domain onto an inverted pixel range', () => {
    const scale = linearScale({ min: 0, max: 100 }, [200, 0]);
    expect(scale(0)).toBe(200);
    expect(scale(50)).toBe(100);
    expect(scale(100)).toBe(0);
  });
});

describe('tick labels', () => {
  it('abbreviates with k / M / B / T, three significant digits, in the locale', () => {
    expect(formatTick(0, 'en')).toBe('0');
    expect(formatTick(1500, 'en')).toBe('1.5k');
    expect(formatTick(2_500_000, 'en')).toBe('2.5M');
    expect(formatTick(-3_000_000_000, 'en')).toBe('-3B');
    expect(formatTick(1.5e12, 'en')).toBe('1.5T');
    expect(formatTick(123.456, 'en')).toBe('123');
    expect(formatTick(0.5, 'de')).toBe('0,5');
    expect(formatTick(1234.5, 'ja')).toBe('1.23k');
  });

  it('switches to exponents past 10^15 and below 10^-3', () => {
    expect(formatTick(2e15, 'en')).toBe('2e+15');
    expect(formatTick(0.0005, 'en')).toBe('5e-4');
    expect(formatTick(1.7e308, 'en')).toBe('1.7e+308');
  });

  it('grows the precision until neighbouring labels differ, then thins the ticks', () => {
    expect(tickLabels([1000, 1001, 1002], 'en').labels).toEqual(['1k', '1.001k', '1.002k']);
    // Two values a double cannot tell apart at 17 digits: half the ticks go.
    const same = tickLabels([1, 1 + Number.EPSILON / 4, 2], 'en');
    expect(same.ticks).toEqual([1, 2]);
    expect(same.labels).toEqual(['1', '2']);
  });
});

describe('time steps', () => {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  it('takes the finest step that covers the span in the ticks there is room for', () => {
    expect(chooseTimeStep(HOUR, 6)).toEqual({ unit: 'minute', count: 10 });
    expect(chooseTimeStep(DAY, 6)).toEqual({ unit: 'hour', count: 6 });
    expect(chooseTimeStep(10 * DAY, 5)).toEqual({ unit: 'day', count: 2 });
    expect(chooseTimeStep(30 * DAY, 5)).toEqual({ unit: 'week', count: 1 });
    expect(chooseTimeStep(365 * DAY, 5)).toEqual({ unit: 'month', count: 3 });
    expect(chooseTimeStep(1, 5)).toEqual({ unit: 'millisecond', count: 1 });
    expect(chooseTimeStep(0, 5)).toEqual({ unit: 'millisecond', count: 1 });
  });

  it('keeps going by ten past five years, as far as any span reaches', () => {
    expect(chooseTimeStep(365 * DAY * 1_000, 5)).toEqual({ unit: 'year', count: 200 });
    expect(chooseTimeStep(365 * DAY * 500_000, 4)).toEqual({ unit: 'year', count: 200_000 });
  });

  it('never ticks inside a day for a date column', () => {
    expect(chooseTimeStep(HOUR, 6, 'day')).toEqual({ unit: 'day', count: 1 });
    expect(chooseTimeStep(3 * DAY, 8, 'day')).toEqual({ unit: 'day', count: 1 });
  });
});

describe('time ticks', () => {
  const at = (...parts: [number, number, number, number?, number?, number?, number?]) => Date.UTC(...parts);

  it('puts a fixed step on the boundaries of its own unit', () => {
    const ticks = timeTicks({ min: at(2024, 0, 2, 3, 4), max: at(2024, 0, 2, 4, 0) }, { unit: 'minute', count: 15 });
    expect(ticks).toEqual([at(2024, 0, 2, 3, 15), at(2024, 0, 2, 3, 30), at(2024, 0, 2, 3, 45), at(2024, 0, 2, 4, 0)]);
  });

  it('steps months by the calendar, not by thirty days', () => {
    const ticks = timeTicks({ min: at(2024, 0, 1), max: at(2025, 0, 1) }, { unit: 'month', count: 3 });
    expect(ticks).toEqual([at(2024, 0, 1), at(2024, 3, 1), at(2024, 6, 1), at(2024, 9, 1), at(2025, 0, 1)]);
    // February of a leap year is 29 days long and the next tick is still the first.
    const monthly = timeTicks({ min: at(2024, 1, 1), max: at(2024, 3, 1) }, { unit: 'month', count: 1 });
    expect(monthly).toEqual([at(2024, 1, 1), at(2024, 2, 1), at(2024, 3, 1)]);
  });

  it('aligns months and years to a multiple of the step', () => {
    expect(timeTicks({ min: at(2024, 1, 15), max: at(2024, 8, 1) }, { unit: 'month', count: 6 }))
      .toEqual([at(2024, 6, 1)]);
    expect(timeTicks({ min: at(1966, 0, 1), max: at(2001, 0, 1) }, { unit: 'year', count: 10 }))
      .toEqual([at(1970, 0, 1), at(1980, 0, 1), at(1990, 0, 1), at(2000, 0, 1)]);
  });

  it('starts weeks on Monday, on both sides of the epoch', () => {
    const ticks = timeTicks({ min: at(2024, 0, 2), max: at(2024, 0, 23) }, { unit: 'week', count: 1 });
    expect(ticks).toEqual([at(2024, 0, 8), at(2024, 0, 15), at(2024, 0, 22)]);
    expect(ticks.every(tick => new Date(tick).getUTCDay() === 1)).toBe(true);
    const before = timeTicks({ min: at(1969, 11, 1), max: at(1969, 11, 20) }, { unit: 'week', count: 1 });
    expect(before.every(tick => new Date(tick).getUTCDay() === 1)).toBe(true);
  });

  it('is UTC throughout, so a day is a day across a daylight-saving change', () => {
    const ticks = timeTicks({ min: at(2024, 2, 9), max: at(2024, 2, 12) }, { unit: 'day', count: 1 });
    expect(ticks).toEqual([at(2024, 2, 9), at(2024, 2, 10), at(2024, 2, 11), at(2024, 2, 12)]);
    expect(ticks[2] - ticks[1]).toBe(86_400_000);
  });

  it('has no ticks without a span', () => {
    expect(timeTicks({ min: 0, max: 0 }, { unit: 'day', count: 1 })).toEqual([]);
    expect(timeTicks({ min: 5, max: 1 }, { unit: 'day', count: 1 })).toEqual([]);
  });
});

describe('time labels', () => {
  it('writes a year in four digits, with a sign outside them', () => {
    expect(formatYear(2024)).toBe('2024');
    expect(formatYear(1)).toBe('0001');
    expect(formatYear(-1)).toBe('-0001');
    expect(formatYear(-8982)).toBe('-8982');
    expect(formatYear(12921)).toBe('+12921');
  });

  it('labels a tick with as much of the instant as its step distinguishes', () => {
    const instant = Date.UTC(2024, 0, 2, 3, 4, 5, 678);
    expect(formatTimeTick(instant, 'year')).toBe('2024');
    expect(formatTimeTick(instant, 'month')).toBe('2024-01');
    expect(formatTimeTick(instant, 'day')).toBe('2024-01-02');
    expect(formatTimeTick(instant, 'week')).toBe('2024-01-02');
    expect(formatTimeTick(instant, 'hour')).toBe('01-02 03:04');
    expect(formatTimeTick(instant, 'minute')).toBe('01-02 03:04');
    expect(formatTimeTick(instant, 'second')).toBe('03:04:05');
    expect(formatTimeTick(instant, 'millisecond')).toBe('03:04:05.678');
  });

  it('names the days beside an axis whose labels are clock times, and only there', () => {
    const day = { min: Date.UTC(2024, 0, 2, 1), max: Date.UTC(2024, 0, 2, 23) };
    expect(timeAxisDates(day, 'minute')).toEqual(['2024-01-02']);
    expect(timeAxisDates({ min: day.min, max: Date.UTC(2024, 0, 3, 5) }, 'second')).toEqual(['2024-01-02', '2024-01-03']);
    expect(timeAxisDates(day, 'day')).toBeNull();
    expect(timeAxisDates(day, 'month')).toBeNull();
  });
});

describe('time domain', () => {
  it('gives a single instant a window to sit in the middle of', () => {
    const instant = Date.UTC(2024, 0, 2);
    expect(timeDomain({ min: instant, max: instant })).toEqual({ min: instant - 500, max: instant + 500 });
    expect(timeDomain({ min: instant, max: instant }, 'day')).toEqual({ min: instant - 43_200_000, max: instant + 43_200_000 });
    expect(timeDomain({ min: 1, max: 2 })).toEqual({ min: 1, max: 2 });
  });
});
