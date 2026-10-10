// Adversary pass r3 on the fixed-slot rotation (logic.ts pickRound, commit 8beccf0), 2026-10-10.
//
// logic.ts pickRound doc and README "Known limit": "rounds share a slot only when one stays pending while ten
// later round ids are created ... the worst first turn of a healthy round came on run 49 (three ids in one slot,
// two of them stuck)". pickRound doc: "10 rounds closing together, one stuck: all healthy ones settle within
// 10 runs". TASKS T0.1c: "every round settled within 10 minutes of closeTime, by CRE alone".
//
// The premise is not what makes ids share a slot. MakoRoundsV1 assigns ids sequentially, and a round is ACTIVE
// (it holds its id and a MAX_ACTIVE_ROUNDS place) from schedule() until it settles, with startTime up to
// MAX_LEAD = 7 days ahead (mako-contracts src/MakoRoundsV1.sol:57, :425-443). So round 10, scheduled with a
// long lead, and round 20, scheduled after rounds 11..19 came and went, close together and share slot 0 with
// no round ever stuck in pendingSettlement while ten ids were created. Healthy rounds sharing a slot with each
// other then need ONE stuck round elsewhere (here round 9, alone in slot 9, whose own boundary reports cannot
// settle: e.g. spread too wide at its close second) to absorb every fallback turn: minutes 1..9 all fall
// through to slot 9, so slot 0 is served once per ten minutes.
import { describe, expect, test } from 'bun:test';
import { dueRounds, pickRound } from '../logic';

const DURATION = 900n; // MakoRoundsV1.DURATION
const DELAY = 10; // config.staging.json settleDelaySeconds

/// Runs from the first second-15 run after close until every healthy round has settled (a healthy pick
/// settles and leaves pendingSettlement; a stuck pick spends the run).
function runsToDrain(closes: Map<bigint, bigint>, stuck: Set<bigint>, firstRunS: number): number {
  let pending = [...closes.keys()];
  let nowS = firstRunS;
  let runs = 0;
  while (pending.some((id) => !stuck.has(id))) {
    const pick = pickRound(dueRounds(pending, closes, DURATION, nowS, DELAY), nowS);
    if (pick === null) throw new Error('nothing due while rounds are pending');
    runs += 1;
    if (!stuck.has(pick.roundId)) pending = pending.filter((id) => id !== pick.roundId);
    nowS += 60;
    if (runs > 1_000) break;
  }
  return runs;
}

describe('adversary: shared slot without a round staying pending', () => {
  test('adversary-shared-slot-premise: two healthy long-lead rounds in one slot, one stuck round alone in its slot, settle within ten runs', () => {
    let worst = { runs: 0, closeAt: 0 };
    // Close at the real BTC/USD fixture's minute mark (1789529160, see fixtures/) and the next 39 minute marks.
    for (let k = 0; k < 40; k++) {
      const closeAt = 1_789_529_160 + 60 * k;
      const closes = new Map<bigint, bigint>([
        [9n, BigInt(closeAt - 3600)], // stuck, closed an hour earlier, alone in slot 9
        [10n, BigInt(closeAt)], // healthy, scheduled with a long lead before ids 11..19
        [20n, BigInt(closeAt)], // healthy, same close as round 10
      ]);
      const runs = runsToDrain(closes, new Set([9n]), closeAt + 15);
      if (runs > worst.runs) worst = { runs, closeAt };
    }
    const verdict = worst.runs <= 10 ? 'within 10 runs' : `${worst.runs} runs (close ${worst.closeAt})`;
    expect(verdict).toBe('within 10 runs');
  });

  test('adversary-shared-slot-worst: the stated worst case (run 49) is not the worst with one stuck round', () => {
    // Nine healthy rounds in slot 0 (ids 10..90, all long-lead, closing together) and one stuck round, 9.
    let worst = { runs: 0, closeAt: 0 };
    for (let k = 0; k < 100; k++) {
      const closeAt = 1_789_529_160 + 60 * k;
      const closes = new Map<bigint, bigint>([[9n, BigInt(closeAt - 3600)]]);
      for (let i = 1; i <= 9; i++) closes.set(BigInt(10 * i), BigInt(closeAt));
      const runs = runsToDrain(closes, new Set([9n]), closeAt + 15);
      if (runs > worst.runs) worst = { runs, closeAt };
    }
    const verdict = worst.runs <= 49 ? 'within the stated worst (49 runs)' : `${worst.runs} runs (close ${worst.closeAt})`;
    expect(verdict).toBe('within the stated worst (49 runs)');
  });
});
