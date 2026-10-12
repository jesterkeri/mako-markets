// Adversary pass r4 on the own-slot-then-rotate rule (logic.ts pickRound, commit f59e860), 2026-10-10.
//
// logic.ts pickRound doc: "with a stuck round there is NO hard bound. Measured: worst first turn of a healthy
// round 17 runs in the adversary's targeted cases ... and 24 runs over 100,000 random worlds (up to 10 pending,
// up to 3 stuck)." README (Differences from the keeper): "the measured worst first turn of a healthy round is
// 17 runs in the adversary's targeted cases (pinned by a test) and 24 over 100,000 random cases."
//
// Those measurements put every round due at once. Real rounds close at different minute marks, and a round is
// stuck because a BOUNDARY report cannot settle it (MakoRoundsV1._settle checks each report at its own
// boundary, mako-contracts src/MakoRoundsV1.sol:605-606), so every round closing at that minute is stuck
// together. The world below is inside the stated class (9 pending at most, 3 stuck) and inside the contract's
// constraints: 9 active rounds (MAX_ACTIVE_ROUNDS 10), all scheduled ahead with a long lead (MAX_LEAD 7 days),
// starts on minute marks (BOUNDARY_STEP 60), closeTime = startTime + 900, sequential ids (any residues are
// reachable because ids in between can come and go while these wait). ONE bad Data Streams report, at close
// minute +9, makes rounds 14, 23 and 168 stuck. Round 129 closes one minute later and gets its first turn on
// run 38 after it is due, past both stated figures.
import { describe, expect, test } from 'bun:test';
import { dueRounds, pickRound } from '../logic';

const DURATION = 900n; // MakoRoundsV1.DURATION
const DELAY = 10; // config.staging.json settleDelaySeconds

// A real minute mark: 2026-09-07T10:20:00Z. pickRound depends on the minute only modulo 25,200
// (minute mod 10, floor(minute / 10) mod own.length <= 10, minute mod due.length <= 10).
const BASE_S = 1_788_841_200;

// [id, close minute offset from BASE_S]. The report at BASE_S + 9 * 60 is bad, so the three rounds closing
// there are stuck (no round anchors there: an anchor at +9 would close at +24).
const ROUNDS: [bigint, number][] = [
  [148n, 4],
  [14n, 9],
  [23n, 9],
  [168n, 9],
  [129n, 10],
  [189n, 11],
  [140n, 17],
  [19n, 20],
  [89n, 29],
];
const BAD_BOUNDARY_S = BASE_S + 9 * 60;

describe('adversary: staggered closes, one bad boundary report', () => {
  // Adversary r4 asserted the then-stated worst (24 runs) and got 38; the claim was withdrawn (f59e860 -> next
  // commit): the docs now state no worst case, only found examples, and this world is pinned as one of them.
  test('adversary-staggered-closes: one bad boundary, 3 stuck: the documented example (first turn on run 38)', () => {
    const closes = new Map(ROUNDS.map(([id, m]) => [id, BigInt(BASE_S + 60 * m)]));
    const isStuck = (id: bigint) => {
      const close = Number(closes.get(id)!);
      return close === BAD_BOUNDARY_S || close - Number(DURATION) === BAD_BOUNDARY_S;
    };
    const stuck = ROUNDS.filter(([id]) => isStuck(id)).length;
    expect(ROUNDS.length).toBeLessThanOrEqual(10); // "up to 10 pending"
    expect(stuck).toBe(3); // "up to 3 stuck"

    const settled = new Set<bigint>();
    const firstDueRun = new Map<bigint, number>();
    let worst = { runs: 0, id: 0n };
    // One run a minute at second 15 (config.schedule), from the first close until every healthy round settled.
    for (let run = 0, nowS = BASE_S + 15; run < 1_000; run++, nowS += 60) {
      const pending = ROUNDS.filter(([id]) => closes.get(id)! <= BigInt(nowS) && !settled.has(id)).map(([id]) => id);
      if (ROUNDS.every(([id]) => isStuck(id) || settled.has(id))) break;
      for (const id of pending) if (!firstDueRun.has(id)) firstDueRun.set(id, run);
      const pick = pickRound(dueRounds(pending, closes, DURATION, nowS, DELAY), nowS);
      if (pick === null || isStuck(pick.roundId)) continue; // a stuck pick spends the run
      settled.add(pick.roundId);
      const runs = run - firstDueRun.get(pick.roundId)! + 1;
      if (runs > worst.runs) worst = { runs, id: pick.roundId };
    }
    expect(`round ${worst.id}: first turn on run ${worst.runs}`).toBe('round 129: first turn on run 38');
  });
});
