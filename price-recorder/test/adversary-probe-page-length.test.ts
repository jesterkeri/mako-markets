// Adversary (2cfc492): CHARTS_DS_PLAN 3.4 page-length rule, "a page with more entries than the limit asked for is not
// a page", and 4.1, the hourly restoration probe asks `/reports/page` with `limit=1`.
// client.ts parsePage still bounds a page by PAGE_LIMIT (100), whatever `limit` the call asked for, so a probe that
// asked for 1 and got 2 to 100 entries is classified `ok`, and the tick logs `feed_restored` from a body that is not a
// page.
// Data: the open-minute-BTC capture (test/fixtures/capture-2026-10-16, PROVENANCE.md), real entries, unmodified; only
// the count per answer differs (2 entries where 1 was asked for).
import { describe, expect, it } from 'vitest';

import { pageClient } from '../src/client';
import { capture, obsOf } from './helpers';
import { BASE, CREDS, FakeStreams, msForLive, recordOnly, tick, virtualClock } from './tick-helpers';

const M = 1792076400; // 2026-10-15 15:00:00 UTC, an hourly tick (the probe runs)
const BTC_PAGE = capture('open-minute-BTC');
const BTC_ID = String(BTC_PAGE[0].feedID).toLowerCase();

describe('adversary: the page-length rule follows the limit asked for (plan 3.4, 4.1)', () => {
  it('a call that asked for limit=1 and got 2 real entries is not a page', async () => {
    const two = BTC_PAGE.slice(0, 2);
    expect(two.length).toBe(2);
    const client = pageClient({ fetchImpl: async () => Response.json({ reports: two }), base: BASE, creds: CREDS, now: () => 0 });
    expect((await client(BTC_ID, obsOf(two[0]), 100)).kind).toBe('ok'); // within the limit asked: a page
    expect((await client(BTC_ID, obsOf(two[0]), 1)).kind).toBe('failed'); // more than the limit asked: not a page
  });

  it('the hourly probe does not log feed_restored from an answer of 2 entries to limit=1', async () => {
    // Control: the probe answered as asked (one real entry) is a restoration, so validOnce accepts these entries.
    await recordOnly(['EURUSD']); // BTC is listed in config.feeds_refused: it gets one probe
    const c1 = virtualClock(msForLive(M));
    const ok = await tick(new FakeStreams(c1, [BTC_PAGE]), c1);
    expect(ok.events.filter((e) => e.event === 'feed_restored').map((e) => e.symbol)).toContain('BTC');

    // The same probe answered with 2 entries: not a page, so no restoration.
    const c2 = virtualClock(msForLive(M + 60) + 60_000 * 59); // the next hourly tick, M + 3600
    const over = new FakeStreams(c2, [], (call) =>
      call.feedId === BTC_ID ? { status: 200, body: JSON.stringify({ reports: BTC_PAGE.slice(0, 2) }) } : null,
    );
    const bad = await tick(over, c2);
    expect(over.calls.some((c) => c.feedId === BTC_ID && c.limit === 1)).toBe(true);
    expect(bad.events.filter((e) => e.event === 'feed_restored').map((e) => e.symbol)).not.toContain('BTC');
  });
});
