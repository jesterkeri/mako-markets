// Adversary pass r5 on the own-slot-then-rotate rule (logic.ts pickRound, commit 59bbd3e), 2026-10-10.
//
// logic.ts pickRound doc: "no healthy round waits forever: while the due set is unchanged, the minute-slot
// visits cycle through every member of each slot, and arrivals are finite (MAX_ACTIVE_ROUNDS, MIN_LEAD)."
// README: "No healthy round waits forever."
//
// Arrivals are not finite. MAX_ACTIVE_ROUNDS caps how many rounds are active AT ONCE, and MIN_LEAD only delays
// a new round; a settled or refunded round frees its place, so new rounds keep arriving for as long as anyone
// schedules them. A round stays settleable for SUBMIT_WINDOW = 24 h after close and then can only refund
// (NoPrice). So "waits forever" for CRE means: never picked in its 1,440 runs.
//
// The world, every step checked against MakoRoundsV1 (mako-contracts src/MakoRoundsV1.sol):
//   - ONE bad boundary report, at minute C-1, makes four rounds stuck (closes at C-1, ids in slots 4,4,4,9).
//   - H (slot 4) closes at C with good reports. The due list is [P,P,P,P9,H] sorted by close: H is index 4.
//     Fallback minutes (slots 0-3, 5-8) pick due[m mod 5] = due[slot mod 5], never index 4; slot 9 picks P9.
//   - Slot-4 minutes pick own[k mod 4] with own = [P,P,P,H]: H on k = 3 mod 4. Before each such visit, one to
//     three healthy slot-4 rounds T are scheduled to close at exactly that minute, making own.length 5..7 so
//     k mod own.length != 3. Each T is due only at that run; whichever is not picked is settled by anyone
//     (settle is permissionless) before the next run.
//   - Ids are sequential; one-sided filler rounds (scheduled MIN_LEAD ahead, refunded OneSided at entry close)
//     advance the counter so each T gets a slot-4 id. At most 10 active rounds at every step, so 10 creator
//     accounts suffice (one active round per creator).
//   - One more stuck round closes at C+1439 (bad close report), the minute the four P rounds leave the window.
//
// Note: with every transaction at second 1 or later (fillers cost 600 s, not 540 s) the same construction found
// a healthy round first picked on run 1,039 (17 h), not never; the shortfall is filler throughput around the
// visits that need three T. The claim is about pickRound, so the keeper (first try at close + 300 s) is out of
// this world on purpose: in production it would settle H; this test is about what the docs say CRE guarantees.
import { describe, expect, test } from 'bun:test';
import { dueRounds, pickRound } from '../logic';

const DURATION_M = 15; // MakoRoundsV1.DURATION 900 s
// MIN_LEAD 600 s. The adversary's transactions land in a block stamped on the minute mark (second 0; Monad
// testnet makes about two blocks a second), so startTime = now + 600 exactly and a filler is refundable 540 s
// later. With transactions at second 1 or later every filler costs 600 s instead (see the note above).
const MIN_LEAD_M = 10;
const ENTRY_LEAD_M = 1; // ENTRY_LEAD 60 s
const MAX_LEAD_M = 7 * 1440; // MAX_LEAD 7 days
const WINDOW_M = 1440; // SUBMIT_WINDOW 24 h
const MAX_ACTIVE = 10; // MAX_ACTIVE_ROUNDS
const DELAY = 10; // config.staging.json settleDelaySeconds

type Kind = 'stuck' | 'healthy' | 'filler';
interface R { id: number; start: number; close: number; kind: Kind; twoSided: boolean; active: boolean }
interface Demand { slot: number; close: number; tag: string; id?: number }

function simulate(C: number, horizon: number) {
  // Bad boundary reports (spread too wide, say): every round anchoring or closing at one of these is stuck.
  const bad = new Set([C - 1, C + WINDOW_M - 1]);
  const stuckAt = (close: number) => bad.has(close) || bad.has(close - DURATION_M);
  const rounds: R[] = [];
  let count = 0;
  const demands: Demand[] = [
    { slot: 4, close: C - 1, tag: 'P' },
    { slot: 4, close: C - 1, tag: 'P' },
    { slot: 4, close: C - 1, tag: 'P' },
    { slot: 9, close: C - 1, tag: 'P9' },
    { slot: 4, close: C, tag: 'H' },
    { slot: (C + WINDOW_M - 1) % 10, close: C + WINDOW_M - 1, tag: 'Q' },
  ];
  // Slot-4 visits where own = [P,P,P,H] would pick H (k = 3 mod 4): the fewest T that move the index off H.
  let maxT = 0;
  for (let m = C; m < C + WINDOW_M; m++) {
    if (m % 10 !== 4) continue;
    const k = Math.floor(m / 10);
    let t = 0;
    while (k % (4 + t) === 3) t++;
    maxT = Math.max(maxT, t);
    for (let i = 0; i < t; i++) demands.push({ slot: 4, close: m, tag: 'T' });
  }
  for (const d of demands) expect(stuckAt(d.close)).toBe(d.tag === 'P' || d.tag === 'P9' || d.tag === 'Q');
  const isH = (r: R) => r.id === demands[4].id;
  const active = () => rounds.filter((r) => r.active).length;

  let hPicked: number | null = null;
  let hDueRuns = 0;
  for (let m = C - 400; m < C + WINDOW_M; m++) {
    // Second 0 of minute m: anyone's transactions.
    for (const r of rounds) {
      // finalizeRefund(OneSided): block.timestamp >= startTime - ENTRY_LEAD and a pool empty.
      if (r.active && !r.twoSided && m >= r.start - ENTRY_LEAD_M) r.active = false;
      // finalizeRefund(NoPrice): block.timestamp >= closeTime + SUBMIT_WINDOW.
      if (r.active && m >= r.close + WINDOW_M) r.active = false;
    }
    // schedule() only while _activeIds.length < MAX_ACTIVE_ROUNDS; ids are sequential (++roundCount).
    while (active() < MAX_ACTIVE) {
      const id = count + 1;
      const d = demands
        .filter((x) => x.id === undefined && x.slot === id % 10 && x.close - DURATION_M >= m + MIN_LEAD_M && x.close - m <= horizon)
        .sort((a, b) => a.close - b.close)[0];
      // A demanded round is entered on both sides; a filler is left one-sided and refunded at entry close.
      const start = d ? d.close - DURATION_M : m + MIN_LEAD_M;
      expect(start - m >= MIN_LEAD_M && start - m <= MAX_LEAD_M).toBe(true);
      count = id;
      const kind: Kind = d ? (stuckAt(start + DURATION_M) ? 'stuck' : 'healthy') : 'filler';
      rounds.push({ id, start, close: start + DURATION_M, kind, twoSided: !!d, active: true });
      if (d) d.id = id;
    }

    // Second 15: the CRE run as main.ts does it: pendingSettlement(), closeTimeOf, dueRounds, pickRound.
    const nowS = m * 60 + 15;
    const pending = rounds
      .filter((r) => r.active && r.twoSided && r.close * 60 <= nowS && nowS < (r.close + WINDOW_M) * 60)
      .map((r) => BigInt(r.id));
    const closes = new Map(rounds.map((r) => [BigInt(r.id), BigInt(r.close * 60)]));
    const due = dueRounds(pending, closes, BigInt(DURATION_M * 60), nowS, DELAY);
    if (demands[4].id !== undefined && due.some((x) => x.roundId === BigInt(demands[4].id!))) hDueRuns++;
    const pick = pickRound(due, nowS);
    if (pick !== null) {
      const r = rounds.find((x) => BigInt(x.id) === pick.roundId)!;
      if (isH(r)) {
        hPicked = m - C + 1;
        break;
      }
      if (r.kind === 'healthy') r.active = false; // the workflow settles it; a stuck pick spends the run
    }
    // Later in the minute: a T that was due and not picked is settled by anyone (settle is permissionless).
    for (const r of rounds) if (r.active && r.kind === 'healthy' && !isH(r) && r.close <= m) r.active = false;
  }
  const unplaced = demands.filter((d) => d.id === undefined).length;
  return { hPicked, hDueRuns, unplaced, maxT, hId: demands[4].id };
}

describe('adversary: rounds keep arriving', () => {
  test('adversary-continuous-arrivals: a healthy round is never picked in its whole 24 h window', () => {
    // C: H's close minute (minutes since the epoch), 2026-09-07T10:21:00Z. Chosen so the window's slot-4 visits
    // never need four T at once (k = 3 mod 420) and so every T could be scheduled in time.
    const C = 29_814_021;
    const r = simulate(C, 120);
    expect(r.unplaced).toBe(0); // every P, H, Q and T was scheduled inside the contract's rules
    expect(r.maxT).toBeLessThanOrEqual(3);
    // The documented claim: no healthy round waits forever, so H gets at least one turn while it can settle.
    // Adversary r5 asserted H is picked and it never was; the liveness claim was withdrawn and this world is pinned
    // as the documented limit: H is due on every run of its 24 h window and never picked by CRE (the keeper
    // settles it from close + 300 s).
    expect(`H (round ${r.hId}) due on ${r.hDueRuns} runs, first picked on run ${r.hPicked}`).toBe(`H (round ${r.hId}) due on 1440 runs, first picked on run null`);
  });
});
