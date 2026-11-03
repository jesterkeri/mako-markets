// Adversary pass on feat/pool-card-preview c427d1f (pool link preview as one column), against the owner's spec of
// 2026-10-26, rule 2: "Every question the create flow accepts (up to 200 bytes, MAX_QUESTION_BYTES in
// src/lib/pool-create.ts) is drawn whole ... and no text overlaps another element (the side pill at top 594, the
// footer, the art right of the 900px text column, the canvas edge), for long questions ... and every pool state
// (open, betting closed, waiting, settled YES/NO, refund, not settled automatically)."
//
// Real renders through renderPoolCard (the route's fonts, art and Satori/resvg path), decoded with sharp. Inputs are
// built with the repo's own helpers (poolInviteCard, poolQr) at lengths the repo allows. The CJK case lets next/og
// fetch its fallback glyphs, exactly as the route does in production.
//
// How overlap is seen: the side pill is drawn after the text column, so text that runs under it is hidden, not shown
// on top. What stays visible is the part of the line just above the pill's top edge (y 594). Each case is compared
// with the same pool, labels and state but a one-line question, whose column ends far above the pill: any pixel that
// differs in the 4 rows directly above the pill, across its flat top edge, is column text reaching into the pill.

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { MarketType, Outcome, type MarketWithId } from '../contract';
import { renderPoolCard } from '../pnl-card-image';
import { poolInviteCard } from '../pool-invite';
import { poolQr } from '../pool-qr';
import { unsettleable } from '../pool-rules';

const U = 1_000_000n;
const NOW = 1792134704;
const POOL: MarketWithId = {
  id: 158n,
  creator: '0x0c3f00000000000000000000000000000000f6a6',
  mType: MarketType.MAKO,
  oracleRef: '0x4554483a67743a32343236000000000000000000000000000000000000000000',
  question: 'Rain?',
  createdAt: BigInt(NOW - 3600),
  bettingCloseTime: BigInt(NOW + 2 * 86400),
  closeTime: BigInt(NOW + 3 * 86400),
  totalYes: 2n * U,
  totalNo: 5n * U,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};
const YN = { yes: 'YES', no: 'NO' };

/// A pool the resolver cannot read, betting closed: the card's "not settled automatically" state, whose sub line is the
/// longest any state writes (two lines in the 900px column).
const MANUAL: MarketWithId = { ...POOL, mType: MarketType.CRYPTO, oracleRef: `0x${'00'.repeat(32)}`, bettingCloseTime: BigInt(NOW - 60) };

type Raw = { data: Buffer; width: number };

async function render(m: MarketWithId, labels: { yes: string; no: string }): Promise<Raw> {
  const res = await renderPoolCard(poolInviteCard(m, NOW, labels, 'UTC'), m.question, await poolQr(m.id));
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width };
}

function diffIn(a: Raw, b: Raw, x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 3;
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) n++;
    }
  }
  return n;
}

/// Column text in the 4 rows just above the side pill (top 594), across its flat top edge (the pill starts at x 76 with
/// a rounded end; with YES/NO it is about 565px wide).
async function textAtPillEdge(m: MarketWithId, labels: { yes: string; no: string }): Promise<number> {
  const card = await render(m, labels);
  const ref = await render({ ...m, question: 'Rain?' }, labels);
  return diffIn(card, ref, 140, 580, 590, 594);
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('pool link preview, spec rule 2 (nothing overlaps the side pill)', () => {
  it('control: a 197-byte question of ordinary words in the not-settled-automatically state clears the pill', async () => {
    const q = 'Will the combined total of goals scored by Wolverhampton Wanderers and Nottingham Forest across every Premier League fixture this weekend be above 4.5 at full time and also ten corners?';
    expect(bytes(q)).toBeLessThanOrEqual(200);
    expect(unsettleable(MANUAL)).toBe(true);
    expect(await textAtPillEdge({ ...MANUAL, question: q }, YN)).toBe(0);
  }, 60_000);

  it('a Japanese question of 63 characters (189 bytes) in the not-settled-automatically state keeps its sub line off the pill', async () => {
    const q = '明日の東京の最高気温は二十五度を超えるでしょうか明日の東京の最高気温は二十五度を超えるでしょうか明日の東京の最高気温は二十五度';
    expect(bytes(q)).toBe(189);
    expect(await textAtPillEdge({ ...MANUAL, question: q }, YN), 'pixels of column text in rows 590-593, just above the pill').toBe(0);
  }, 60_000);

  it('a 200-byte question that is one unbroken word keeps the sub line off the pill (open pool)', async () => {
    const q = `${'W'.repeat(199)}?`;
    expect(bytes(q)).toBe(200);
    expect(await textAtPillEdge({ ...POOL, question: q }, YN), 'pixels of column text in rows 590-593, just above the pill').toBe(0);
  }, 60_000);
});

// Added with the fix: the adversary's unproven suspicion (wide Latin words with a two-line sub line) and the other
// inputs the width estimate must cover.
describe('pool link preview, more inputs at the pill edge', () => {
  const words = 'WWWW '.repeat(40).trim();
  const house = { yes: 'W'.repeat(32), no: 'M'.repeat(32) };
  it.each([
    ['wide words, not settled automatically', { ...MANUAL, question: words }, YN],
    ['wide words, open, 32-byte house names', { ...POOL, question: words }, house],
    ['50 emoji (200 bytes), not settled automatically', { ...MANUAL, question: '🎉'.repeat(50) }, YN],
    ['66 CJK characters, open, 32-byte house names', { ...POOL, question: '明'.repeat(66) }, house],
  ])('%s', async (_name, m, labels) => {
    expect(bytes(m.question)).toBeLessThanOrEqual(200);
    expect(await textAtPillEdge(m, labels)).toBe(0);
  }, 60_000);
});
