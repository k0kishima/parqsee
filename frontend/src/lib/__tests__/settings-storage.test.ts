import { describe, it, expect, afterEach, vi } from 'vitest';
import { systemLanguage } from '../settings-storage';

const asLanguage = (value: string) =>
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(value);

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
