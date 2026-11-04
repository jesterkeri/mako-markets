// The five-minute cron runs at minutes 3, 8, ... (wrangler.toml, Codex WORKERS_NO_BATCH R1 F2). The comments probe
// must still run once each half hour and the market-page and charts probes once each hour, at any minute offset.

import { describe, expect, it } from 'vitest';
import { dueProbes } from '../src/probes';

function hour(offset: number) {
  const runs = Array.from({ length: 12 }, (_, k) => Date.UTC(2026, 10, 4, 14, offset + 5 * k, 0));
  return runs.map((t) => ({ minute: new Date(t).getUTCMinutes(), ...dueProbes(t) }));
}

describe('dueProbes at every cron offset', () => {
  for (const offset of [0, 1, 3, 4]) {
    it(`offset ${offset}: comments twice an hour, page and charts once`, () => {
      const runs = hour(offset);
      expect(runs.filter((r) => r.nc).map((r) => r.minute)).toEqual([offset, 30 + offset]);
      expect(runs.filter((r) => r.mp).map((r) => r.minute)).toEqual([offset]);
      expect(runs.filter((r) => r.ch).map((r) => r.minute)).toEqual([offset]);
    });
  }
});
