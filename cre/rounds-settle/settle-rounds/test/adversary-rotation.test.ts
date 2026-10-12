// Adversary pass on the stateless minute rotation (logic.ts pickRound), 2026-10-10.
//
// pickRound's own contract (logic.ts, doc comment on pickRound): the keeper's per-round "last tried" memory
// means "a round that cannot settle ... spends only its own turn and never blocks the rounds behind it", and
// the rotation is said to give "the same guarantee". TASKS T0.1c also bounds CRE alone at "every round settled
// within 10 minutes of closeTime" for ten rounds closing in the same second.
//
// Scenario: T0.1c (a), ten rounds (MAX_ACTIVE_ROUNDS) closing at the same minute mark, one of which can never
// settle (its report is missing or its spread is too wide, so every attempt reverts or waits). The workflow
// runs once a minute at second 0, takes pickRound(dueRounds(...)), and a healthy pick settles and leaves
// pendingSettlement. The keeper's rule needs 10 runs here: one wasted turn on the stuck round, then the nine
// healthy ones. The minute rotation keeps landing on the stuck round as the due list shrinks.
import { describe, expect, test } from 'bun:test';
import { dueRounds, pickRound } from '../logic';

const DURATION = 900n; // MakoRoundsV1.DURATION
const DELAY = 10; // config.staging.json settleDelaySeconds

/// Runs needed until every healthy round has settled, starting from the first cron run after close + delay.
function runsToDrain(closeAt: number, ids: bigint[], stuck: bigint): number {
  const closes = new Map(ids.map((id) => [id, BigInt(closeAt)] as const));
  let pending = [...ids];
  let nowS = closeAt + 60; // first minute mark at or after close + DELAY
  let runs = 0;
  while (pending.some((id) => id !== stuck)) {
    const pick = pickRound(dueRounds(pending, closes, DURATION, nowS, DELAY), nowS);
    if (pick === null) throw new Error('nothing due while rounds are pending');
    if (pick.roundId !== stuck) pending = pending.filter((id) => id !== pick.roundId);
    nowS += 60;
    runs += 1;
    if (runs > 1_000) break;
  }
  return runs;
}

describe('adversary: minute rotation with one round that can never settle', () => {
  test('adversary-stuck-round: nine healthy rounds behind one stuck round settle within ten runs', () => {
    // Close at the real BTC/USD fixture's minute mark (1789529160, see fixtures/) and the next 2519 minute
    // marks, so every residue of the minute counter mod 1..10 is covered; the stuck round is each id in turn.
    const ids = Array.from({ length: 10 }, (_, i) => BigInt(i + 1));
    let worst = { runs: 0, closeAt: 0, stuck: 0n };
    for (let k = 0; k < 2520; k++) {
      const closeAt = 1_789_529_160 + 60 * k;
      for (const stuck of ids) {
        const runs = runsToDrain(closeAt, ids, stuck);
        if (runs > worst.runs) worst = { runs, closeAt, stuck };
      }
    }
    // Keeper parity: the stuck round costs one turn, so 9 healthy + 1 = 10 runs (10 minutes, the T0.1c bound).
    // On failure the received object names the worst case (close second and stuck id) so it can be replayed.
    const verdict = worst.runs <= 10 ? 'within 10 runs' : `${worst.runs} runs (close ${worst.closeAt}, stuck round ${worst.stuck})`;
    expect(verdict).toBe('within 10 runs');
  });
});
