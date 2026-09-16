import { describe, it, expect } from 'vitest';
import { barDomain, formatTick, linearScale, linearTicks, niceStep, paddedDomain, tickLabels } from '../chart-scales';

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
