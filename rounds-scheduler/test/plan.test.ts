import { describe, expect, it } from 'vitest';

import { houseOf, LEAD_MARGIN_S, MIN_LEAD_S, planSchedule, upcomingSlots, type ChainView } from '../src/plan';

const H = 7200; // two hours
const T = 1_790_000_000 - (1_790_000_000 % H); // an even slot boundary
const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;
const view = (over: Partial<ChainView> = {}): ChainView => ({
  nowS: T + 60,
  houses: [
    { address: A, activeRoundId: 0n, activeStart: null },
    { address: B, activeRoundId: 0n, activeStart: null },
  ],
  activeRoundCount: 0n,
  maxActiveRounds: 10n,
  scheduledStarts: [],
  ...over,
});

describe('slots', () => {
  it('are whole multiples of the interval, the first at least the minimum lead plus margin away', () => {
    const s = upcomingSlots(T + 60, H);
    expect(s).toEqual([T + H, T + 2 * H]);
    for (const x of s) expect(x % 60).toBe(0);
  });
  it('skip a slot too close to schedule safely', () => {
    expect(upcomingSlots(T + H - MIN_LEAD_S - LEAD_MARGIN_S + 1, H)[0]).toBe(T + 2 * H);
    expect(upcomingSlots(T + H - MIN_LEAD_S - LEAD_MARGIN_S, H)[0]).toBe(T + H);
  });
  it('alternate between the two houses', () => {
    expect(houseOf(T, H)).not.toBe(houseOf(T + H, H));
    expect(houseOf(T, H)).toBe(houseOf(T + 2 * H, H));
  });
  it('refuse an interval that is not whole minutes', () => {
    expect(() => upcomingSlots(T, 90)).toThrow();
  });
});

describe('planSchedule', () => {
  it('schedules both upcoming slots, one per house, when both are free', () => {
    const p = planSchedule(view(), H);
    expect(p.actions).toEqual([
      { kind: 'schedule', house: houseOf(T + H, H), startTime: T + H },
      { kind: 'schedule', house: houseOf(T + 2 * H, H), startTime: T + 2 * H },
    ]);
    expect(new Set(p.actions.map((a) => a.house)).size).toBe(2);
  });
  it('leaves a slot that is already scheduled alone, by anyone', () => {
    const p = planSchedule(view({ scheduledStarts: [T + H] }), H);
    expect(p.actions.map((a) => a.startTime)).toEqual([T + 2 * H]);
    expect(p.skips).toContainEqual({ slot: T + H, reason: 'already-scheduled' });
  });
  it('waits while the slot house still has an unfinished round (one per creator)', () => {
    const h = houseOf(T + H, H);
    const houses = view().houses;
    houses[h] = { ...houses[h], activeRoundId: 7n, activeStart: T - H };
    const p = planSchedule(view({ houses, activeRoundCount: 1n }), H);
    expect(p.actions.map((a) => a.startTime)).toEqual([T + 2 * H]);
    expect(p.skips).toContainEqual({ slot: T + H, reason: 'house-busy' });
  });
  it('is idempotent: once both are scheduled it does nothing', () => {
    const houses = view().houses;
    houses[houseOf(T + H, H)] = { ...houses[houseOf(T + H, H)], activeRoundId: 1n, activeStart: T + H };
    houses[houseOf(T + 2 * H, H)] = { ...houses[houseOf(T + 2 * H, H)], activeRoundId: 2n, activeStart: T + 2 * H };
    const p = planSchedule(view({ houses, activeRoundCount: 2n, scheduledStarts: [T + H, T + 2 * H] }), H);
    expect(p.actions).toEqual([]);
  });
  it('never exceeds the global cap of unfinished rounds', () => {
    expect(planSchedule(view({ activeRoundCount: 10n }), H).actions).toEqual([]);
    expect(planSchedule(view({ activeRoundCount: 9n }), H).actions).toHaveLength(1);
  });
  it('works with any whole-minute interval', () => {
    expect(planSchedule(view({ nowS: T + 60 }), 4 * 3600).actions.every((a) => a.startTime % (4 * 3600) === 0)).toBe(true);
  });
});
