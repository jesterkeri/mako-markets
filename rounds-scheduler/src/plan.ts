// What the house should schedule next, as a pure decision over what the chain says now. No I/O here, so every rule is
// tested directly (test/plan.test.ts).
//
// The schedule: one BTC round every `intervalS` seconds (2 hours), starting on whole multiples of the interval in
// UTC (00:00, 02:00, ...). Two house creators alternate by slot, because MakoRoundsV1 lets a creator hold only one
// unfinished round: slot k is house k % 2. Each slot is scheduled as early as its house is free, up to two slots
// ahead, so predictions stay open for hours and pots build. The contract enforces every limit itself (creator list,
// one unfinished round per creator, the global cap, lead time, whole minutes); these checks only avoid sending a
// transaction that would be refused.

/// MakoRoundsV1's fixed values (SPEC §4).
export const MIN_LEAD_S = 600;
export const MAX_LEAD_S = 7 * 86_400;
export const BOUNDARY_STEP_S = 60;
/// Seconds of headroom past the minimum lead, so a transaction sent near the edge still lands in time.
export const LEAD_MARGIN_S = 180;
/// How many upcoming slots are kept scheduled.
export const SLOTS_AHEAD = 2;

export type HouseView = {
  address: `0x${string}`;
  /// `creatorActiveRound(address)`: 0 when the house has no unfinished round.
  activeRoundId: bigint;
  /// The start time of that round (unix seconds), when there is one.
  activeStart: number | null;
};

export type ChainView = {
  nowS: number;
  houses: [HouseView, HouseView];
  activeRoundCount: bigint;
  maxActiveRounds: bigint;
  /// Start times of rounds already scheduled by anyone that are still unfinished (so a slot taken by a manual round
  /// is left alone).
  scheduledStarts: number[];
};

export type Action = { kind: 'schedule'; house: 0 | 1; startTime: number };
export type Skip = { slot: number; reason: 'already-scheduled' | 'house-busy' | 'cap-reached' | 'too-soon' | 'too-far' };
export type Plan = { actions: Action[]; skips: Skip[] };

/// The house that owns a slot: alternate by slot number.
export const houseOf = (slot: number, intervalS: number): 0 | 1 => (Math.floor(slot / intervalS) % 2 === 0 ? 0 : 1);

/// The next `SLOTS_AHEAD` slot start times that are still schedulable from `nowS`.
export function upcomingSlots(nowS: number, intervalS: number): number[] {
  if (intervalS <= 0 || intervalS % BOUNDARY_STEP_S !== 0) throw new Error('interval must be a positive whole number of minutes');
  const first = Math.ceil((nowS + MIN_LEAD_S + LEAD_MARGIN_S) / intervalS) * intervalS;
  return Array.from({ length: SLOTS_AHEAD }, (_, i) => first + i * intervalS);
}

export function planSchedule(v: ChainView, intervalS: number): Plan {
  const actions: Action[] = [];
  const skips: Skip[] = [];
  let active = v.activeRoundCount;
  const busy = v.houses.map((h) => h.activeRoundId !== 0n);
  for (const slot of upcomingSlots(v.nowS, intervalS)) {
    const h = houseOf(slot, intervalS);
    if (v.scheduledStarts.includes(slot) || v.houses[h].activeStart === slot) {
      skips.push({ slot, reason: 'already-scheduled' });
      continue;
    }
    if (busy[h]) {
      skips.push({ slot, reason: 'house-busy' });
      continue;
    }
    if (active >= v.maxActiveRounds) {
      skips.push({ slot, reason: 'cap-reached' });
      continue;
    }
    if (slot < v.nowS + MIN_LEAD_S + LEAD_MARGIN_S) {
      skips.push({ slot, reason: 'too-soon' });
      continue;
    }
    if (slot > v.nowS + MAX_LEAD_S) {
      skips.push({ slot, reason: 'too-far' });
      continue;
    }
    actions.push({ kind: 'schedule', house: h, startTime: slot });
    busy[h] = true;
    active += 1n;
  }
  return { actions, skips };
}
