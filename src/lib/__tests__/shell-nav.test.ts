import { describe, expect, it } from 'vitest';

import { activeNav, NAV } from '../shell-nav';

describe('activeNav', () => {
  it.each([
    ['/rounds', 'rounds'],
    ['/rounds/142', 'rounds'],
    ['/rounds/new', 'rounds'],
    ['/pools', 'pools'],
    ['/pools/231', 'pools'],
    ['/news', 'news'],
    ['/leaderboard', 'leaderboard'],
    ['/me', 'me'],
    ['/settings', 'me'],
    ['/notifications', 'me'],
  ])('%s lights %s', (path, key) => {
    expect(activeNav(path)).toBe(key);
  });

  it.each(['/', '/signin', '/legal', '/u/dayo', '/intel', '/nope', '/newsroom'])('%s lights nothing', (path) => {
    expect(activeNav(path)).toBeNull();
  });

  it('does not light a tab for a route that only shares a prefix', () => {
    expect(activeNav('/roundsabc')).toBeNull();
    expect(activeNav('/mechanics')).toBeNull();
  });

  it('Pools first, no Home tab, News between Rounds and Leaderboard (Joshua, 2026-10-07)', () => {
    expect(NAV.map((n) => n.label)).toEqual(['Pools', 'Rounds', 'News', 'Leaderboard', 'Me']);
    expect(NAV.find((n) => n.key === 'news')?.href).toBe('/news');
  });
});
