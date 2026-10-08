// Adversary on 9ce69c5 (spec 2026-10-08, item 2): a typed local time that does not exist is refused AND the person
// sees why. The two kinds of non-existent time are different: an impossible calendar date (30 February, 31 April)
// and a daylight-saving spring-forward gap. The reason shown must be true for the value typed, so an impossible date
// must not be blamed on the clocks jumping forward, least of all in a timezone that never changes its clocks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fromLocalInput, localInputProblem } from '../datetime-local';

describe('the reason shown for an impossible calendar date', () => {
  const realTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC'; // no daylight saving, ever
  });
  afterAll(() => {
    process.env.TZ = realTz;
  });

  for (const value of ['2027-02-30T10:00', '2027-04-31T10:00']) {
    it(`${value} is refused and not blamed on a clock change`, () => {
      expect(fromLocalInput(value)).toBeNull(); // precondition: the parser refuses it (this part is right)
      // UTC has no spring-forward gap, so a "clocks jump forward" reason is false here.
      expect(localInputProblem(value)).not.toMatch(/clocks jump forward/i);
    });
  }

  it('names the real reason for an impossible date', () => {
    expect(localInputProblem('2027-02-30T10:00')).toBe('That date or time does not exist. Pick another.');
  });

  it('a year below 100 is that year, not 19xx (it is then refused as in the past, not as a missing date)', () => {
    // 0050-06-01T10:00 UTC in Unix seconds (proleptic Gregorian), checked with Python datetime.
    expect(fromLocalInput('0050-06-01T10:00')).toBe(-60_576_213_600);
  });
});
