import { describe, test, expect } from 'bun:test';
import { ulid } from 'ulid';

import { decodeUlidTimestamp } from '../../src/lib/ulid-utils';

describe('decodeUlidTimestamp', () => {
  test('decodes ULID to timestamp within 1ms of now', () => {
    const before = Date.now();
    const id = ulid();
    const after = Date.now();

    const decoded = decodeUlidTimestamp(id);
    expect(decoded).toBeGreaterThanOrEqual(before);
    expect(decoded).toBeLessThanOrEqual(after);
  });

  test('decodes ULID with specific timestamp', () => {
    // Generate ULID with known timestamp
    const knownTime = 1700000000000; // 2023-11-14
    const id = ulid(knownTime);
    const decoded = decodeUlidTimestamp(id);
    expect(decoded).toBe(knownTime);
  });

  test('preserves ordering (newer ULID → larger timestamp)', () => {
    const id1 = ulid();
    // tiny delay to ensure different timestamp
    const id2 = ulid(Date.now() + 1000);

    expect(decodeUlidTimestamp(id2)).toBeGreaterThan(decodeUlidTimestamp(id1));
  });

  test('handles lowercase ULID', () => {
    const id = ulid();
    const upper = decodeUlidTimestamp(id);
    const lower = decodeUlidTimestamp(id.toLowerCase());
    expect(upper).toBe(lower);
  });

  test('returns a valid Date-compatible timestamp', () => {
    const id = ulid();
    const ts = decodeUlidTimestamp(id);
    const date = new Date(ts);
    expect(date.getFullYear()).toBeGreaterThanOrEqual(2024);
    expect(date.getFullYear()).toBeLessThanOrEqual(2030);
  });
});
