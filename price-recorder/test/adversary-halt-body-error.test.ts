// Adversary on d7b6ac0 (CHARTS_DS_PLAN r24 16.1 row 6, 4.1): a 401 is classified from its body, and anything but
// `error` exactly "feeds not authorized" (no body included) is a whole-key failure, which halts the tick; every
// unfinished unit of a halted tick keeps its tries. Here the unit's second page answers 401 and its body stream fails
// before any byte arrives (a reset connection), so there is no refusal body at all.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { repairWindow } from '../src/backfill';
import type { PageEntry } from '../src/entry';
import { HOUR } from '../src/rollup';
import { capture, feed, withWord } from './helpers';
import { FakeStreams, msForLive, recordOnly, rows, tick, virtualClock } from './tick-helpers';

const M = 1792177740; // 2026-10-16 19:09:00 UTC, not an hourly tick (as in backfill.test.ts)
const { last: LAST } = repairWindow(M + 60);
const V3 = capture('live-page-BTC')[0];
function btcSeconds(from: number, to: number): PageEntry[] {
  const id = BigInt(feed('BTC').feedId);
  const out: PageEntry[] = [];
  for (let s = from; s < to; s++) {
    const blob = withWord(withWord(withWord(V3, 0, id), 1, BigInt(s)), 2, BigInt(s));
    out.push({ ...blob, feedID: feed('BTC').feedId, validFromTimestamp: s, observationsTimestamp: s });
  }
  return out;
}

describe('adversary: a 401 whose body cannot be read during a backfill unit', () => {
  it('is a whole-key failure: key_failure recorded, no further call, tries unchanged', async () => {
    const H = LAST;
    await recordOnly(['BTC']);
    await env.DB.prepare('INSERT INTO todo (feed, hour, tries) VALUES (?1, ?2, 0)').bind('BTC', H).run();
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, [btcSeconds(H, H + HOUR + 100)]);
    let unitPages = 0;
    let after = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const start = Number(url.searchParams.get('startTimestamp'));
      if (unitPages >= 2) after++;
      if (start >= H && start < H + HOUR && ++unitPages === 2) {
        await fake.fetch(input, init); // still signed and recorded by the fake
        const body = new ReadableStream<Uint8Array>({ start: (c) => c.error(new Error('connection reset')) });
        return new Response(body, { status: 401 });
      }
      return fake.fetch(input, init);
    };
    const r = await tick(fake, clock, { fetchImpl });
    expect(unitPages).toBe(2);
    expect.soft(r.run?.key_failure).toBe(1);
    expect.soft(after).toBe(0);
    expect((await rows('SELECT tries FROM todo WHERE feed = ?1 AND hour = ?2', 'BTC', H))[0]?.tries).toBe(0);
  }, 60_000);
});
