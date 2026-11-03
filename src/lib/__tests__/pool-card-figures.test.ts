// Codex R1 F2: the side pill grows with its figures, which are uint256 totals and uint32 bettor counts. Real renders
// with the widest valid side names and the largest figures, against the same pool with small figures: nothing may
// change right of x 1300, so the pill stays far from the canvas edge (1600), and nothing below the pill (the footer).

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { MarketType, Outcome, type MarketWithId } from '../contract';
import { renderPoolCard } from '../pnl-card-image';
import { poolInviteCard } from '../pool-invite';
import { poolQr } from '../pool-qr';

const NOW = 1792134704;
const MAX = 2n ** 256n - 1n;
const POOL: MarketWithId = {
  id: 158n,
  creator: '0x0c3f00000000000000000000000000000000f6a6',
  mType: MarketType.MAKO,
  oracleRef: '0x4554483a67743a32343236000000000000000000000000000000000000000000',
  question: 'Rain?',
  createdAt: BigInt(NOW - 3600),
  bettingCloseTime: BigInt(NOW + 2 * 86400),
  closeTime: BigInt(NOW + 3 * 86400),
  totalYes: 2_000_000n,
  totalNo: 5_000_000n,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};
const HOUSE = { yes: 'W'.repeat(32), no: 'M'.repeat(32) };

type Raw = { data: Buffer; width: number };

async function render(m: MarketWithId): Promise<Raw> {
  const res = await renderPoolCard(poolInviteCard(m, NOW, HOUSE, 'UTC'), m.question, await poolQr(m.id));
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

describe('pool link preview, the largest figures (Codex R1 F2)', () => {
  it.each([
    ['both totals near uint256 max, uint32-max bettors', { totalYes: MAX / 2n, totalNo: MAX / 2n, yesBettorCount: 4294967295, noBettorCount: 4294967295 }],
    ['one unit against the rest: the largest pays', { totalYes: 1n, totalNo: MAX - 1n, yesBettorCount: 4294967295, noBettorCount: 4294967295 }],
    ['just under a million USDC a side, the longest exact amount', { totalYes: 999_999_994_999n, totalNo: 999_999_994_999n, yesBettorCount: 999_999, noBettorCount: 999_999 }],
  ])('%s: the side pill stays clear of the canvas edge and the footer', async (_name, figures) => {
    const card = await render({ ...POOL, ...figures });
    const ref = await render(POOL);
    expect(diffIn(card, ref, 1300, 1600, 560, 760), 'pixels changed right of x 1300 around the pill').toBe(0);
    expect(diffIn(card, ref, 0, 1600, 720, 900), 'pixels changed below the pill').toBe(0);
  }, 60_000);
});
