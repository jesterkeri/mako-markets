// The admin market form's date pickers (Joshua, 2026-10-08): a datetime-local value round-trips to Unix seconds in
// the browser's timezone, junk is refused, and the description names UTC and how far ahead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeTime, fromLocalInput, toLocalInput } from '../datetime-local';

const realTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Africa/Lagos'; // UTC+1, Joshua's timezone
});
afterAll(() => {
  process.env.TZ = realTz;
});

describe('datetime-local helpers', () => {
  it('round-trips a minute-aligned time in the local timezone', () => {
    const sec = Date.UTC(2026, 9, 9, 13, 30) / 1000; // 13:30 UTC = 14:30 in Lagos
    expect(toLocalInput(sec)).toBe('2026-10-09T14:30');
    expect(fromLocalInput('2026-10-09T14:30')).toBe(sec);
  });

  it('refuses empty or malformed values', () => {
    for (const v of ['', '2026-10-09', '14:30', '2026-13-40T99:99', 'garbage']) {
      const r = fromLocalInput(v);
      expect(r === null || Number.isNaN(r), v).toBe(true);
    }
  });

  it('describes a time in UTC with how far ahead it is', () => {
    const now = Date.UTC(2026, 9, 8, 12, 0) / 1000;
    expect(describeTime(now + 86400 + 2 * 3600 + 5 * 60, now)).toBe('2026-10-09 14:05 UTC · in 1 d 2 h 5 min');
    expect(describeTime(now + 45 * 60, now)).toBe('2026-10-08 12:45 UTC · in 45 min');
    expect(describeTime(now - 60, now)).toBe('2026-10-08 11:59 UTC · in the past');
  });
});
