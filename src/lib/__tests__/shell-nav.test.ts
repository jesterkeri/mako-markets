import { describe, expect, it } from 'vitest';

import { activeNav, NAV } from '../shell-nav';

describe('activeNav', () => {
  it.each([
    ['/', 'home'],
    ['/rounds', 'rounds'],
    ['/rounds/142', 'rounds'],
    ['/rounds/new', 'rounds'],
    ['/pools', 'pools'],
    ['/pools/231', 'pools'],
    ['/leaderboard', 'leaderboard'],
    ['/me', 'me'],
    ['/settings', 'me'],
    ['/notifications', 'me'],
  ])('%s lights %s', (path, key) => {
    expect(activeNav(path)).toBe(key);
  });

  it.each(['/signin', '/legal', '/u/dayo', '/intel', '/nope'])('%s lights nothing', (path) => {
    expect(activeNav(path)).toBeNull();
  });

  it('does not light a tab for a route that only shares a prefix', () => {
    expect(activeNav('/roundsabc')).toBeNull();
    expect(activeNav('/mechanics')).toBeNull();
  });

  it('keeps the design order', () => {
    expect(NAV.map((n) => n.label)).toEqual(['Home', 'Rounds', 'Pools', 'Leaderboard', 'Me']);
  });
});
