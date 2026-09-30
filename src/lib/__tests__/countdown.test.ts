import { describe, expect, it } from 'vitest';

import { formatCountdown } from '../countdown';

describe('formatCountdown (DESIGN_RULES durations)', () => {
  it.each([
    [2 * 86_400 + 3_600 + 59, '2D 1H'],
    [86_400, '1D 0H'],
    [86_399, '23H 59M'],
    [6 * 3_600 + 11 * 60 + 30, '6H 11M'],
    [3_600, '1H 0M'],
    [3_599, '59:59'],
    [45 * 60 + 2, '45:02'],
    [7, '00:07'],
    [0, '00:00'],
  ])('%i seconds reads %s', (s, out) => {
    expect(formatCountdown(s)).toBe(out);
  });

  it('never reads a duration over a day in hours alone', () => {
    expect(formatCountdown(49 * 3_600)).toBe('2D 1H');
  });

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])('reads %s as 00:00', (s) => {
    expect(formatCountdown(s)).toBe('00:00');
  });

  it('drops fractions of a second', () => {
    expect(formatCountdown(59.9)).toBe('00:59');
  });
});
