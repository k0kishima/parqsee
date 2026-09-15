import { describe, it, expect, afterEach, vi } from 'vitest';
import { defaultSettings, loadSettings, saveSettings, systemLanguage } from '../settings-storage';

const asLanguage = (value: string) =>
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(value);

describe('persisted settings', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([null, 'dense', 'constructor', {}, 1])('recovers from invalid row density %j while retaining other preferences', rowDensity => {
    localStorage.setItem('parqsee-settings', JSON.stringify({ rowDensity, theme: 'dark', restoreTabs: false }));
    expect(loadSettings()).toEqual({ ...defaultSettings, theme: 'dark', restoreTabs: false });
  });

  it.each([0, -1, '50', null, 1.5, 1e300, 10000])('replaces invalid page size %j', rowsPerPage => {
    localStorage.setItem('parqsee-settings', JSON.stringify({ rowsPerPage }));
    expect(loadSettings().rowsPerPage).toBe(defaultSettings.rowsPerPage);
  });

  it.each([25, 50, 100, 200, 500])('round-trips supported preferences with %i rows per page', rowsPerPage => {
    const settings = { ...defaultSettings, rowsPerPage, theme: 'light' as const, language: 'ja' as const,
      typeDisplay: 'both' as const, rowDensity: 'compact' as const, restoreTabs: false };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
  });

  it('validates every persisted field independently', () => {
    localStorage.setItem('parqsee-settings', JSON.stringify({
      theme: null, language: 'fr', typeDisplay: [], restoreTabs: 'false', rowDensity: 'compact', extra: 1,
    }));
    expect(loadSettings()).toEqual({ ...defaultSettings, rowDensity: 'compact' });
  });

  it.each([null, [], 'dark', 42, true].map(saved => ({ saved })))('ignores non-object settings $saved', ({ saved }) => {
    localStorage.setItem('parqsee-settings', JSON.stringify(saved));
    expect(loadSettings()).toEqual(defaultSettings);
  });

  it('defaults missing and malformed settings', () => {
    localStorage.clear();
    expect(loadSettings()).toEqual(defaultSettings);
    localStorage.setItem('parqsee-settings', '{');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadSettings()).toEqual(defaultSettings);
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('systemLanguage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the primary subtag, whatever the region', () => {
    for (const tag of ['ja', 'ja-JP', 'JA-jp', 'ja-Jpan-JP']) {
      asLanguage(tag);
      expect(systemLanguage(), tag).toBe('ja');
    }
  });

  it('falls back to English for a language the app does not have', () => {
    for (const tag of ['en', 'en-GB', 'de-DE', 'jav', '']) {
      asLanguage(tag);
      expect(systemLanguage(), tag).toBe('en');
    }
  });
});
