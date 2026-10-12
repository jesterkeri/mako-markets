// Adversary pass on the fixed-slot rotation (logic.ts pickRound, commit 0a0449d), 2026-10-10.
//
// README "Facts this relies on": "Each due round still gets a turn at least once every *n* minutes."
// TASKS T0.1c: "every round settled within 10 minutes of closeTime, by CRE alone".
//
// Slots are round id mod 10, but the deployed MakoRoundsV1 assigns ids as `roundId = ++roundCount`
// (mako-contracts src/MakoRoundsV1.sol:445), so ids only grow, and a round whose settle keeps reverting
// stays in pendingSettlement() for SUBMIT_WINDOW = 24 hours. Two pending rounds therefore share a slot as
// soon as ten more rounds have been scheduled behind a stuck one: on the deployed contract (3 creators, one
// active round each) that takes a few hours. In a shared slot the pick index is floor(minute / 10) mod 2, which
// does not change for ten consecutive minutes, and the "next occupied slot" fallback lands on the same slot,
// so the stuck round takes every run of that decade.
//
// Scenario: round 1 cannot settle (its spread is too wide, every attempt reverts); round 11, healthy, closes
// later at a minute mark. Nothing else is pending.
import { describe, expect, test } from 'bun:test';
import { dueRounds, pickRound } from '../logic';

const DURATION = 900n; // MakoRoundsV1.DURATION
const DELAY = 10; // config.staging.json settleDelaySeconds

describe('adversary: two pending rounds in the same slot', () => {
  test('adversary-slot-collision: a healthy round sharing a slot with a stuck round is picked within ten runs', () => {
    let worst = { runs: 0, closeAt: 0 };
    // Close round 11 at the real BTC/USD fixture's minute mark (1789529160, see fixtures/) and the next 39
    // minute marks, so every residue of the minute counter mod 20 is covered. Round 1 closed an hour earlier.
    for (let k = 0; k < 40; k++) {
      const closeAt = 1_789_529_160 + 60 * k;
      const closes = new Map<bigint, bigint>([
        [1n, BigInt(closeAt - 3600)],
        [11n, BigInt(closeAt)],
      ]);
      let nowS = closeAt + 60; // first minute mark at or after close + DELAY
      let runs = 0;
      for (;;) {
        runs += 1;
        const pick = pickRound(dueRounds([1n, 11n], closes, DURATION, nowS, DELAY), nowS);
        if (pick?.roundId === 11n || runs > 100) break;
        nowS += 60;
      }
      if (runs > worst.runs) worst = { runs, closeAt };
    }
    // Run r is at closeAt + 60 r, so run 10 is the last one that can settle within 10 minutes of close.
    const verdict = worst.runs <= 10 ? 'within 10 runs' : `round 11 first picked on run ${worst.runs} (close ${worst.closeAt})`;
    expect(verdict).toBe('within 10 runs');
  });
});
