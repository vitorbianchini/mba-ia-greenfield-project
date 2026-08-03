import { PUBLIC_ID_LENGTH, generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('returns an id of the declared length', () => {
    expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('uses only URL-safe characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces no duplicate across 10000 draws', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(generatePublicId());
    }

    expect(ids.size).toBe(10_000);
  });

  it('reaches every symbol of the alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i++) {
      for (const char of generatePublicId()) {
        seen.add(char);
      }
    }

    // 64-symbol alphabet: A-Z, a-z, 0-9, '-', '_'
    expect(seen.size).toBe(64);
  });
});
