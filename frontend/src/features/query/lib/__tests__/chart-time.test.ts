import { describe, it, expect } from 'vitest';
import wireCases from '../../../../../../contracts/temporal-wire-cases.json';
import { daysInMonth, MAX_INSTANT, parseDateValue, parseTimestampValue, utcInstant } from '../chart-time';

const parse = (kind: string, value: string) => (kind === 'date' ? parseDateValue(value) : parseTimestampValue(value));

describe('the wire format the backend writes', () => {
  it.each(wireCases)('places $value', ({ value, kind, epochMs, subMs }) => {
    expect(parse(kind, value)).toEqual({ ok: true, value: epochMs, subMillisecond: subMs });
  });

  // The expectations above are absolute instants, so a parser that let the
  // host's zone in would fail them everywhere but UTC. This says it outright.
  it('reads a zoneless timestamp as a wall clock in UTC, whatever zone the machine is in', () => {
    const naive = parseTimestampValue('2024-06-01T12:00:00');
    expect(naive).toEqual({ ok: true, value: Date.UTC(2024, 5, 1, 12, 0, 0), subMillisecond: false });
  });
});

describe('dates', () => {
  it('keeps years 0 to 99 out of the twentieth century', () => {
    expect(parseDateValue('0099-01-01')).toEqual({ ok: true, value: -59042995200000, subMillisecond: false });
    expect(parseDateValue('0000-01-01')).toEqual({ ok: true, value: -62167219200000, subMillisecond: false });
  });

  it('counts the days of a month by the Gregorian rule', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2024, 13)).toBe(0);
    expect(parseDateValue('2000-02-29')).toEqual({ ok: true, value: 951782400000, subMillisecond: false });
  });

  it('refuses a day that does not exist instead of rolling it into the next month', () => {
    for (const value of ['2024-02-30', '2023-02-29', '1900-02-29', '2024-04-31', '2024-13-01', '2024-00-10', '2024-01-32', '2024-01-00']) {
      expect(parseDateValue(value)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses everything Date.parse would have guessed at', () => {
    for (const value of ['2024-1-1', '2024/01/01', 'March 3, 2024', '2024-01-01T00:00:00', '', ' 2024-01-01', 'ERROR: Cast error: Failed to convert 2147483647 to temporal for Date32']) {
      expect(parseDateValue(value)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(parseDateValue(20240101)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDateValue(null)).toEqual({ ok: false, reason: 'missing' });
    expect(parseDateValue(undefined)).toEqual({ ok: false, reason: 'missing' });
  });

  it('counts a day outside the range of a date as precision, not as nonsense', () => {
    expect(parseDateValue('+275760-09-13')).toEqual({ ok: true, value: MAX_INSTANT, subMillisecond: false });
    expect(parseDateValue('-271821-04-20')).toEqual({ ok: true, value: -MAX_INSTANT, subMillisecond: false });
    expect(parseDateValue('+275760-09-14')).toEqual({ ok: false, reason: 'precision' });
    expect(parseDateValue('-271821-04-19')).toEqual({ ok: false, reason: 'precision' });
  });
});

describe('timestamps', () => {
  it('pads a short fraction and truncates a long one towards the earlier instant', () => {
    expect(parseTimestampValue('2024-01-01T00:00:00.5')).toMatchObject({ value: 1704067200500, subMillisecond: false });
    expect(parseTimestampValue('2024-01-01T00:00:00.05')).toMatchObject({ value: 1704067200050, subMillisecond: false });
    expect(parseTimestampValue('2024-01-01T00:00:00.000999')).toMatchObject({ value: 1704067200000, subMillisecond: true });
    // Before the epoch too: the digits are dropped, never rounded away from zero.
    expect(parseTimestampValue('1969-12-31T23:59:59.000001')).toMatchObject({ value: -1000, subMillisecond: true });
    expect(parseTimestampValue('1969-12-31T23:59:59.999000000')).toMatchObject({ value: -1, subMillisecond: false });
  });

  it('applies the offset the column carries and takes a leap day with it', () => {
    expect(parseTimestampValue('2024-02-29T09:00:00+09:00')).toMatchObject({ value: Date.UTC(2024, 1, 29, 0, 0, 0) });
    expect(parseTimestampValue('2024-03-01T00:00:00+09:00')).toMatchObject({ value: Date.UTC(2024, 1, 29, 15, 0, 0) });
    expect(parseTimestampValue('2024-11-03T01:30:00-04:00')).toMatchObject({ value: Date.UTC(2024, 10, 3, 5, 30, 0) });
    expect(parseTimestampValue('2024-11-03T01:30:00-05:00')).toMatchObject({ value: Date.UTC(2024, 10, 3, 6, 30, 0) });
  });

  it('refuses a clock or an offset that does not exist', () => {
    for (const value of ['2024-01-01T24:00:00', '2024-01-01T00:60:00', '2024-01-01T23:59:60', '2024-01-01T00:00:00+24:00', '2024-01-01T00:00:00+00:60']) {
      expect(parseTimestampValue(value)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses the shapes no writer produces', () => {
    for (const value of ['2024-01-01 00:00:00', '2024-01-01T00:00', '2024-01-01', '2024-01-01T00:00:00.', '2024-01-01T00:00:00.1234567890', '2024-01-01T00:00:00+0900', '2024-01-01T00:00:00z']) {
      expect(parseTimestampValue(value)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('counts an instant past the range of a date as precision', () => {
    expect(parseTimestampValue('+275760-09-13T00:00:01')).toEqual({ ok: false, reason: 'precision' });
    // In range as a wall clock, out of it once the offset moves it.
    expect(parseTimestampValue('+275760-09-13T00:00:00-01:00')).toEqual({ ok: false, reason: 'precision' });
  });
});

describe('utcInstant', () => {
  it('is null for fields that name no instant', () => {
    expect(utcInstant(2024, 2, 30)).toBeNull();
    expect(utcInstant(2024, 1, 1, 24)).toBeNull();
    expect(utcInstant(275760, 9, 14)).toBeNull();
    expect(utcInstant(2024, 1, 1, 12, 30, 15, 250)).toBe(Date.UTC(2024, 0, 1, 12, 30, 15, 250));
  });
});
