'use strict';

const DedupCache = require('../src/utils/dedupCache');

describe('DedupCache', () => {
  test('returns false on first call for a key', () => {
    const cache = new DedupCache();
    expect(cache.isDuplicate('event:C123:111.000:PROJ-1')).toBe(false);
  });

  test('returns true on second call for the same key', () => {
    const cache = new DedupCache();
    cache.isDuplicate('event:C123:111.000:PROJ-1');
    expect(cache.isDuplicate('event:C123:111.000:PROJ-1')).toBe(true);
  });

  test('different keys are independent', () => {
    const cache = new DedupCache();
    expect(cache.isDuplicate('key-A')).toBe(false);
    expect(cache.isDuplicate('key-B')).toBe(false);
    expect(cache.isDuplicate('key-A')).toBe(true);
    expect(cache.isDuplicate('key-B')).toBe(true);
  });

  test('entry expires after TTL', async () => {
    const cache = new DedupCache(50); // 50ms TTL for test speed
    cache.isDuplicate('expiring-key');
    await new Promise((r) => setTimeout(r, 100));
    // After TTL, the key should no longer be considered a duplicate
    expect(cache.isDuplicate('expiring-key')).toBe(false);
  });
});
