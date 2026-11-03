// Adversary pass on feat/pool-card-preview ada7c9b (pool link preview drawn in the share card's design), against the
// owner's spec of 2026-10-26, rule 5: "Text in the image must not overflow or clip for long questions, long house
// side names, or large amounts."
//
// Real renders through renderPoolCard (the same fonts, art and Satori/resvg path the route uses), decoded with sharp.
// Inputs are built with the repo's own helpers (poolInviteCard, poolQr) from a pool shaped like the one in
// pool-og-card.test.ts, with lengths the repo itself allows:
//  - a question of at most 200 bytes (pool-create.ts MAX_QUESTION_BYTES, aa-constants.ts CREATE_MARKET_QUESTION_MAX_BYTES);
//  - house side names of at most 32 bytes each (mako-labels.ts MAKO_LABEL_MAX_BYTES, validateLabelPair).

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { MarketType, Outcome, type MarketWithId } from '../contract';
import { validateLabelPair } from '../mako-labels';
import { renderPoolCard } from '../pnl-card-image';
import { poolInviteCard } from '../pool-invite';
import { poolQr } from '../pool-qr';

const U = 1_000_000n;
const NOW = 1792134704;
const POOL: MarketWithId = {
  id: 158n,
  creator: '0x0c3f00000000000000000000000000000000f6a6',
  mType: MarketType.MAKO,
  oracleRef: '0x4554483a67743a32343236000000000000000000000000000000000000000000',
  question: 'Will ETH be above $2,426 at 05:58:16 UTC on Fri 30 Oct?',
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

type Raw = { data: Buffer; width: number };

async function render(m: MarketWithId, labels: { yes: string; no: string }): Promise<Raw> {
  const res = await renderPoolCard(poolInviteCard(m, NOW, labels), m.question, await poolQr(m.id));
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width };
}

/// Pixels that differ between two renders inside a box.
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

function diffAll(a: Raw, b: Raw): number {
  return diffIn(a, b, 0, 1600, 0, 900);
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('pool link preview, spec rule 5 (no overflow or clipping)', () => {
  it('draws the whole of a long question the create flow accepts, not just its first two lines', async () => {
    const stem = 'Will the combined total of goals scored by Wolverhampton Wanderers and Nottingham Forest across every Premier League fixture this weekend be above 4.5 at';
    const q1 = `${stem} full time?`;
    const q2 = `${stem} half time?`;
    expect(bytes(q1)).toBeLessThanOrEqual(200);
    expect(bytes(q2)).toBe(bytes(q1));

    const a = await render({ ...POOL, mType: MarketType.CRYPTO, question: q1 }, { yes: 'YES', no: 'NO' });
    const b = await render({ ...POOL, mType: MarketType.CRYPTO, question: q2 }, { yes: 'YES', no: 'NO' });
    // Two different questions must not produce the same picture: if they do, the words that tell them apart were cut.
    expect(diffAll(a, b), 'pixels that differ between "... full time?" and "... half time?"').toBeGreaterThan(0);
  }, 60_000);

  it('keeps the line under the clock inside the text column when a house pool has long side names', async () => {
    const yes = 'WOLVERHAMPTON WANDERERS WINS IT';
    const no = 'NOTTINGHAM FOREST TAKES IT ALL!!';
    expect(validateLabelPair(yes, no)).toEqual({ ok: true, mode: 'filled' });

    const short = await render(POOL, { yes: 'Rain', no: 'Dry' });
    const long = await render(POOL, { yes, no });
    // The sub line ("Bet <yes> or <no> · settled by Mako Market") sits at about y 490-525. The question column is 900px
    // from x 76 (PoolCardView); everything right of x 1000 on that row is the art, and must be the same art whatever
    // the side names are.
    expect(diffIn(short, long, 1000, 1600, 485, 530), 'pixels of the art covered by the sub line, x >= 1000').toBe(0);
  }, 60_000);
});
