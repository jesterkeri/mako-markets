// The admin market form's date pickers (Joshua, 2026-10-08): a datetime-local value round-trips to Unix seconds in
// the browser's timezone, junk is refused, and the description names UTC and how far ahead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeTime, fromLocalInput, localInputProblem, toLocalInput } from '../datetime-local';

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

// Codex RELEASE_R5 F2/F3: a local time inside a spring-forward gap does not exist. `new Date()` would quietly move it an
// hour later; the parser refuses it and the form says why.
describe('a time inside a daylight-saving gap', () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = tz;
  });

  it('is refused, with a message naming the jump', () => {
    // US clocks jump 02:00 -> 03:00 on 2027-03-14, so 02:30 never happens.
    expect(new Date('2027-03-14T02:30').getHours()).toBe(3); // the silent move this guards against
    expect(fromLocalInput('2027-03-14T02:30')).toBeNull();
    expect(localInputProblem('2027-03-14T02:30')).toMatch(/does not exist in your timezone/);
  });

  it('the minutes either side of the gap still parse', () => {
    expect(fromLocalInput('2027-03-14T01:59')).toBe(Date.UTC(2027, 2, 14, 6, 59) / 1000); // EST, UTC-5
    expect(fromLocalInput('2027-03-14T03:00')).toBe(Date.UTC(2027, 2, 14, 7, 0) / 1000); // EDT, UTC-4
  });

  it('an empty or malformed value asks for a date and time', () => {
    expect(localInputProblem('')).toBe('Pick a date and time.');
    expect(localInputProblem('2027-03-14')).toBe('Pick a date and time.');
  });

  it('impossible calendar dates are refused, not rolled over', () => {
    expect(fromLocalInput('2027-02-30T10:00')).toBeNull();
    expect(fromLocalInput('2027-04-31T10:00')).toBeNull();
  });
});
