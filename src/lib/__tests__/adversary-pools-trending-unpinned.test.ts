// Adversary on 558008c (Pools Trending, Mako Market pools ranked, not pinned; owner spec 2026-10-15 revised).
// Two attacks. (1) The ranking, against an independent reference built from the spec's words, over seeded random
// inputs with heavy ties, bigint pots past 2^53, closed pools, and limits of 0, negative, fractional and above the
// open count. (2) Shipped code and copy must no longer say Mako Market pools come first, are pinned, or sit at the
// top of Trending: the spec forbids that claim anywhere in UI text, aria labels, tour text or shipped comments.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { TRENDING_LIMIT, trendingPools } from '@/lib/pool-list';

const NOW = 1_800_000_000;
const HOUR = 3_600;

// Small deterministic PRNG (mulberry32), so a failure reproduces from its seed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = [MarketType.FOOTBALL, MarketType.CRYPTO, MarketType.BASKETBALL, MarketType.FOREX, MarketType.COMMODITIES, MarketType.STOCKS, MarketType.MAKO];

function randomMarket(r: () => number, id: bigint): MarketWithId {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const state = pick(['open', 'open', 'open', 'open', 'betting_closed', 'resolving', 'resolved'] as const);
  const bettingCloseTime = state === 'open' ? NOW + 1 + Math.floor(r() * 50 * HOUR) : NOW - 1 - Math.floor(r() * 2 * HOUR);
  const closeTime = state === 'betting_closed' ? NOW + HOUR : state === 'open' ? bettingCloseTime + HOUR : NOW - 1;
  // Few distinct values so players, pot and createdAt tie often; pots sometimes past 2^53 base units.
  const potBase = pick([0n, 1_000_000n, 2n ** 60n]);
  return {
    id,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: r() < 0.3 ? MarketType.MAKO : pick(TYPES),
    oracleRef: `0x${'00'.repeat(32)}`,
    question: `Q${id}?`,
    createdAt: BigInt(NOW - 10 * HOUR + pick([0, 0, 60, 120])),
    closeTime: BigInt(closeTime),
    bettingCloseTime: BigInt(bettingCloseTime),
    totalYes: potBase + BigInt(pick([0, 1, 2])),
    totalNo: BigInt(pick([0, 1])),
    yesBettorCount: pick([0, 1, 2, 3]),
    noBettorCount: pick([0, 1]),
    outcome: state === 'resolved' ? pick([Outcome.YES, Outcome.NO, Outcome.REFUND]) : Outcome.UNRESOLVED,
    resolved: state === 'resolved',
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
  };
}

// The spec, written out independently: open = betting not closed and not resolved; order = players desc, pot desc,
// createdAt desc (newest first), then id desc; show the first `cap` and every Mako pool after them, in order.
function reference(markets: readonly MarketWithId[], nowSec: number, limit: number): bigint[] {
  const open = markets.filter((m) => !m.resolved && nowSec < Number(m.bettingCloseTime));
  const key = (m: MarketWithId) => [BigInt(m.yesBettorCount + m.noBettorCount), m.totalYes + m.totalNo, m.createdAt, m.id];
  const ranked = [...open].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i] ? -1 : 1;
    return 0;
  });
  const cap = limit > 0 ? Math.floor(limit) : 0;
  return ranked.filter((m, i) => i < cap || m.mType === MarketType.MAKO).map((m) => m.id);
}

describe('trendingPools against the spec, randomised', () => {
  it('matches the reference for every seed and limit, and every row obeys the spec rules', () => {
    // Cases where a non-Mako pool outranks a Mako one: a pinning implementation fails each of them.
    let unpinned = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const n = Math.floor(r() * 45);
      // Ids shuffled so input order never equals rank order.
      const markets = Array.from({ length: n }, (_, i) => randomMarket(r, BigInt(1000 - i * 7)));
      for (const limit of [TRENDING_LIMIT, 0, -3, 2.9, 1, 5, 1000]) {
        const got = trendingPools(markets, NOW, undefined, limit);
        const want = reference(markets, NOW, limit);
        expect({ seed, limit, ids: got.map((x) => x.id) }).toEqual({ seed, limit, ids: want });
        const cap = limit > 0 ? Math.floor(limit) : 0;
        const mako = new Set(markets.filter((m) => m.mType === MarketType.MAKO).map((m) => m.id));
        const firstMako = want.findIndex((id) => mako.has(id));
        if (firstMako > 0) unpinned++;
        got.forEach((row, i) => {
          expect(row.state).toBe('open');
          if (i >= cap) expect(row.cat).toBe('MAKO');
        });
      }
    }
    expect(unpinned).toBeGreaterThan(100);
  });
});

// Shipped source only: src/app and src/lib, no tests.
function shippedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) out.push(...shippedFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('no shipped code or copy still says Mako Market pools lead Trending', () => {
  it('finds no sentence that puts Mako Market pools first, pinned, or at the top of Trending', () => {
    const root = process.cwd();
    const hits: string[] = [];
    for (const file of [...shippedFiles(join(root, 'src/app')), ...shippedFiles(join(root, 'src/lib'))]) {
      // Join comment lines into prose, then judge one sentence at a time.
      const prose = readFileSync(file, 'utf8')
        .replace(/^\s*(\/\/\/?|\*|\/\*\*?)\s?/gm, '')
        .replace(/\s+/g, ' ');
      for (const raw of prose.split(/(?<=[.!?])\s/)) {
        // "the first HOME_MAKO_ROWS" counts rows; it says nothing about where Mako pools rank.
        const sentence = raw.replace(/\bthe first [A-Z_0-9]+\b/g, '');
        if (/trending/i.test(sentence) && /mako/i.test(sentence) && /\b(pinned|pins|first|at the top|on top)\b/i.test(sentence)) {
          // "The first tab ... is Trending" is about the tab, not the pools in it.
          if (/first tab|trending first/i.test(sentence)) continue;
          hits.push(`${relative(root, file)}: ${sentence.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
