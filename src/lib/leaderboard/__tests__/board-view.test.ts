// Leaderboard (12a) view logic: ranks, names, podium and bar split, the pinned row and the gap to the next player.
// Pure: no DB, no React.

import { describe, expect, it } from 'vitest';

import {
  AVATAR_COLOURS,
  avatarColour,
  BAR_COLOURS,
  barHeights,
  betsText,
  buildBoardView,
  gapToPass,
  INDEX_BEHIND_BLOCKS,
  indexBehind,
  initialOf,
  nextLine,
  playerNames,
  shortMetric,
  signedUsdc2,
  usdc2,
  type BoardSort,
  type BoardWire,
  type BoardWireRow,
  type BoardWireViewer,
} from '../board-view';

const U = 1_000_000n; // base units per USDC

/// A lowercase address ending in `n` (hex).
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;

function row(n: number, over: Partial<BoardWireRow> = {}): BoardWireRow {
  return { actor: addr(n), staked: '0', won: '0', net: '0', bets: 1, creatorFees: '0', displayName: null, ...over };
}

function wire(rows: BoardWireRow[], over: Partial<BoardWire> = {}): BoardWire {
  return { window: 'week', sort: 'profit', rows, indexedThrough: 1, syncing: false, generatedAt: '2026-09-30T00:00:00Z', ...over };
}

/// n rows ranked by profit: row i (1-based) has net (n - i + 1) USDC and stakes i USDC.
function ranked(n: number, sort: BoardSort = 'profit'): BoardWireRow[] {
  return Array.from({ length: n }, (_, k) =>
    row(k + 1, { net: String(BigInt(n - k) * U), staked: String(BigInt(sort === 'volume' ? n - k : k + 1) * U) }),
  );
}

describe('numbers', () => {
  it('usdc2 rounds half up to the cent and groups thousands, from exact base units', () => {
    expect(usdc2(1_234_567_890n)).toBe('1,234.57');
    expect(usdc2(5_000n)).toBe('0.01'); // 0.005 rounds up
    expect(usdc2(4_999n)).toBe('0.00');
    expect(usdc2(0n)).toBe('0.00');
    expect(usdc2(-2_500_000n)).toBe('2.50'); // absolute
    expect(usdc2(9_007_199_254_740_993_000_000n)).toBe('9,007,199,254,740,993.00'); // above 2^53, still exact
  });

  it('signedUsdc2 signs and tones profit, with a real minus sign', () => {
    expect(signedUsdc2(15n * U)).toEqual({ text: '+15.00', tone: 'up' });
    expect(signedUsdc2(-5n * U)).toEqual({ text: '−5.00', tone: 'down' });
    expect(signedUsdc2(0n)).toEqual({ text: '0.00', tone: 'flat' });
  });

  it('shortMetric keeps cents under 100 USDC so a small win never reads +0', () => {
    expect(shortMetric({ net: '300000', staked: '0' }, 'profit')).toBe('+0.30');
    expect(shortMetric({ net: '-4000000', staked: '0' }, 'profit')).toBe('−4.00');
    expect(shortMetric({ net: '412500000', staked: '0' }, 'profit')).toBe('+413');
    expect(shortMetric({ net: '0', staked: '0' }, 'profit')).toBe('0.00');
    expect(shortMetric({ net: '0', staked: '1380000000' }, 'volume')).toBe('1,380');
    expect(shortMetric({ net: '0', staked: '98000000' }, 'volume')).toBe('98.00');
  });

  it('betsText', () => {
    expect(betsText(1)).toBe('1 bet');
    expect(betsText(0)).toBe('0 bets');
    expect(betsText(12)).toBe('12 bets');
  });
});

describe('players', () => {
  it('names a player by display name, else by short address', () => {
    const names = playerNames([row(1, { displayName: 'kemi' }), row(2), row(3, { displayName: '   ' })]);
    expect(names.get(addr(1))).toBe('kemi');
    expect(names.get(addr(2))).toBe('0x0000…0002');
    expect(names.get(addr(3))).toBe('0x0000…0003'); // blank name falls back
  });

  it('adds a short address to a name more than one player uses, counting an off-board viewer', () => {
    const a = row(0xa1, { displayName: 'sam' });
    const viewer = { ...row(0xb2, { displayName: 'sam' }), rank: 150 };
    const names = playerNames([a, row(3, { displayName: 'dayo' })], viewer);
    expect(names.get(a.actor)).toBe('sam · 0x0000…00a1');
    expect(names.get(viewer.actor)).toBe('sam · 0x0000…00b2');
    expect(names.get(addr(3))).toBe('dayo');
    // Without the viewer, "sam" is unique.
    expect(playerNames([a]).get(a.actor)).toBe('sam');
  });

  it('initialOf: first letter of the name, else the first hex digit of the address', () => {
    expect(initialOf('kemi.o', addr(1))).toBe('K');
    expect(initialOf('  dayo', addr(1))).toBe('D');
    expect(initialOf(null, '0xbc5a58487d7949da2b76ac84afc032fd0aa26195')).toBe('B');
    expect(initialOf('', '0x9f00')).toBe('9');
  });

  it('avatarColour is fixed per address, ignores casing, and never uses signal yellow', () => {
    const a = '0xbc5a58487d7949da2b76ac84afc032fd0aa26195';
    expect(avatarColour(a)).toBe(avatarColour(a.toUpperCase().replace('0X', '0x')));
    expect(AVATAR_COLOURS).toContain(avatarColour(a));
    expect(AVATAR_COLOURS).not.toContain('var(--mako-signal)');
    const spread = new Set(Array.from({ length: 64 }, (_, i) => avatarColour(addr(i * 7919))));
    expect(spread.size).toBeGreaterThan(4);
  });
});

describe('barHeights', () => {
  it('scales 120px to 248px against the largest value, as the design does', () => {
    expect(barHeights([100n, 50n, 25n])).toEqual([248, 184, 152]);
  });

  it('gives zero and negative values the minimum and never a taller bar', () => {
    expect(barHeights([10n, 0n, -5n])).toEqual([248, 120, 120]);
    expect(barHeights([-1n, -2n])).toEqual([120, 120]);
    expect(barHeights([0n])).toEqual([120]);
    expect(barHeights([])).toEqual([]);
  });
});

describe('gapToPass', () => {
  const me = (key: bigint, actor = '0x02') => ({ key, actor });
  const ahead = (key: bigint, actor = '0x01') => ({ key, actor });

  it('needs one base unit more than the player ahead when the address tie-break favours them', () => {
    // ahead 0x01 sorts before me 0x02 on a tie, so drawing level is not enough.
    expect(gapToPass(me(10n), ahead(15n))).toBe(6n);
    expect(gapToPass(me(10n), ahead(10n))).toBe(1n);
  });

  it('drawing level is enough when the tie-break favours me', () => {
    expect(gapToPass(me(10n, '0x01'), ahead(15n, '0x02'))).toBe(5n);
  });

  it('is null when I am not actually behind (a stale snapshot)', () => {
    expect(gapToPass(me(20n), ahead(15n))).toBeNull();
    expect(gapToPass(me(10n, '0x01'), ahead(10n, '0x02'))).toBeNull();
  });

  it('nextLine rounds the gap UP to the cent so the amount shown is enough', () => {
    expect(nextLine(12_923_456n, 'profit')).toBe('+12.93 USDC more to pass the next player');
    expect(nextLine(1n, 'profit')).toBe('+0.01 USDC more to pass the next player');
    expect(nextLine(5n * U, 'volume')).toBe('+5.00 USDC more volume to pass the next player');
  });
});

describe('buildBoardView', () => {
  it('ranks rows in API order and splits podium (#2, #1, #3), bars (top 5) and the two lists', () => {
    const v = buildBoardView(wire(ranked(8)), null);
    expect(v.players.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(v.podium.map((p) => p?.rank)).toEqual([2, 1, 3]);
    expect(v.bars.map((b) => b.player.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(v.bars.map((b) => b.bg)).toEqual([...BAR_COLOURS]);
    expect(v.restDesktop.map((p) => p.rank)).toEqual([4, 5, 6, 7, 8]);
    expect(v.restMobile.map((p) => p.rank)).toEqual([6, 7, 8]);
    expect(v.empty).toBe(false);
  });

  it('keeps #1 in the middle of the podium when fewer than three players', () => {
    const one = buildBoardView(wire(ranked(1)), null);
    expect(one.podium.map((p) => p?.rank ?? null)).toEqual([null, 1, null]);
    const two = buildBoardView(wire(ranked(2)), null);
    expect(two.podium.map((p) => p?.rank ?? null)).toEqual([2, 1, null]);
    expect(two.restDesktop).toEqual([]);
  });

  it('bar heights follow the sort, and the tallest is #1', () => {
    const byProfit = buildBoardView(wire(ranked(5)), null);
    expect(byProfit.bars.map((b) => b.heightPx)).toEqual([248, 222, 197, 171, 146]);
    const byVolume = buildBoardView(wire(ranked(5, 'volume'), { sort: 'volume' }), null);
    expect(byVolume.bars[0].heightPx).toBe(248);
  });

  it('shows the sorted-by value: profit (signed) or volume', () => {
    const rows = [row(1, { net: '-2000000', staked: '7000000', creatorFees: '10000' })];
    const byProfit = buildBoardView(wire(rows), null).players[0];
    expect(byProfit.value).toBe('−2.00');
    expect(byProfit.profit.tone).toBe('down');
    expect(byProfit.volume).toBe('7.00');
    expect(byProfit.creator).toBe(true);
    const byVolume = buildBoardView(wire(rows, { sort: 'volume' }), null).players[0];
    expect(byVolume.value).toBe('7.00');
    expect(byVolume.short).toBe('7.00');
  });

  it('marks a creator only when a creator fee was earned', () => {
    const v = buildBoardView(wire([row(1, { creatorFees: '0' }), row(2, { creatorFees: '1' })]), null);
    expect(v.players.map((p) => p.creator)).toEqual([false, true]);
  });

  it('is empty with no rows', () => {
    const v = buildBoardView(wire([], { syncing: true }), addr(1));
    expect(v.empty).toBe(true);
    expect(v.me).toBeNull();
    expect(v.syncing).toBe(true);
    expect(v.podium).toEqual([null, null, null]);
  });
});

describe('buildBoardView: the pinned row', () => {
  it('is absent when signed out, and when the viewer has no activity in the period', () => {
    expect(buildBoardView(wire(ranked(3)), null).me).toBeNull();
    expect(buildBoardView(wire(ranked(3), { viewer: null }), addr(99)).me).toBeNull();
  });

  it('on the board: rank is the board position, the gap is to the row above, and casing does not matter', () => {
    const rows = [row(0xab, { net: String(20n * U) }), row(0xcd, { net: String(7_076_544n) })];
    const v = buildBoardView(wire(rows), addr(0xcd).toUpperCase().replace('0X', '0x'));
    expect(v.me?.player.rank).toBe(2);
    // 20.000000 - 7.076544 = 12.923456, and 0x…ab wins a tie, so one more base unit: 12.923457 -> 12.93.
    expect(v.me?.next).toBe('+12.93 USDC more to pass the next player');
  });

  it('at #1 there is nobody to pass', () => {
    const v = buildBoardView(wire(ranked(3)), addr(1));
    expect(v.me?.player.rank).toBe(1);
    expect(v.me?.next).toBeNull();
  });

  it('off the board just below the last row: the gap is to that row', () => {
    const rows = ranked(3); // last row: net 1 USDC
    const viewer: BoardWireViewer = { ...row(0xff, { net: String(U / 2n), displayName: 'joshua' }), rank: 4 };
    const v = buildBoardView(wire(rows, { viewer }), viewer.actor);
    expect(v.me?.player.rank).toBe(4);
    expect(v.me?.player.name).toBe('joshua');
    // 1.00 - 0.50, and addr(3) sorts before 0x…ff on a tie, so 0.500001 -> 0.51.
    expect(v.me?.next).toBe('+0.51 USDC more to pass the next player');
  });

  it('off the board further down: the player ahead is unknown, so no gap is shown', () => {
    const viewer: BoardWireViewer = { ...row(0xff, { net: '0' }), rank: 40 };
    const v = buildBoardView(wire(ranked(3), { viewer }), viewer.actor);
    expect(v.me?.player.rank).toBe(40);
    expect(v.me?.next).toBeNull();
  });

  it('a live rank that disagrees with the cached board shows no gap rather than a wrong one', () => {
    const viewer: BoardWireViewer = { ...row(0xff, { net: String(50n * U) }), rank: 4 };
    const v = buildBoardView(wire(ranked(3), { viewer }), viewer.actor);
    expect(v.me?.next).toBeNull();
  });

  it('when sorted by volume, the gap is in volume', () => {
    const rows = [row(1, { staked: String(30n * U) }), row(2, { staked: String(10n * U) })];
    const v = buildBoardView(wire(rows, { sort: 'volume' }), addr(2));
    expect(v.me?.player.value).toBe('10.00');
    expect(v.me?.next).toBe('+20.01 USDC more volume to pass the next player');
  });

  it('ignores a viewer block that belongs to another address', () => {
    const viewer: BoardWireViewer = { ...row(0xee), rank: 9 };
    expect(buildBoardView(wire(ranked(3), { viewer }), addr(0xff)).me).toBeNull();
  });
});

describe('indexBehind', () => {
  it('is behind only past INDEX_BEHIND_BLOCKS, and never when either side is unknown', () => {
    expect(indexBehind(1_000, 1_000n + INDEX_BEHIND_BLOCKS)).toBe(false);
    expect(indexBehind(1_000, 1_000n + INDEX_BEHIND_BLOCKS + 1n)).toBe(true);
    expect(indexBehind(null, 10n ** 9n)).toBe(false);
    expect(indexBehind(1_000, undefined)).toBe(false);
  });
});
