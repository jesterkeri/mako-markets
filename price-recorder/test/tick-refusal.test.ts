// CHARTS_DS_PLAN 4.1, 8.6, 12: refusals in the tick, with the real refusal body of 2026-10-16 (Chainlink sent it for
// BAC; here it answers for AAPL, so every such test is labelled "synthetic status"). A per-feed refusal leaves that
// feed's minutes incomplete, asks nothing more for it, lists it in runs.unauthorized and holds it, add-only, in the same
// batch; every other feed is recorded exactly as without the refusal. Any other 401/403 body, or a tick whose every
// answered live page is a refusal, is a whole-key failure: no further call, key_failure = 1, no hold. A 429 stops every
// further call.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { freshDb } from './apply-migrations';
import { FEEDS, type Feed } from '../src/feeds';
import { capture } from './helpers';
import { FakeStreams, msForLive, OTHER_ERROR_BODY, recordOnly, REFUSAL_BODY, rows, snapshot, tick, virtualClock, type Call } from './tick-helpers';

const M = 1792076400; // 2026-10-15 15:00:00 UTC: one real page of 100 per class
const FOUR = ['AAPL', 'BTC', 'EURUSD', 'XAUUSD'];
const SOURCES = ['open-minute-BTC', 'open-minute-EURUSD', 'open-minute-XAUUSD', 'open-minute-AAPL'].map(capture);
const AAPL_ID = '0x0008b8ad';

const refuse = (status: number, body: string, who = AAPL_ID) => (c: Call) => (c.feedId.startsWith(who) ? { status, body } : null);
const without = (snap: Record<string, unknown[]>, feed: string) =>
  Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.filter((r) => (r as { feed?: string; symbol?: string }).feed !== feed && (r as { symbol?: string }).symbol !== feed)]));

async function runAt(minute: number, override: ((c: Call) => { status: number; body: string } | null) | null) {
  const clock = virtualClock(msForLive(minute));
  const fake = new FakeStreams(clock, SOURCES, override);
  return { r: await tick(fake, clock), fake };
}

describe('per-feed refusal (plan 4.1)', () => {
  it('401 "feeds not authorized" for AAPL (synthetic status: real body): AAPL incomplete, one request, listed, held; the other feeds identical to a run without it', async () => {
    await recordOnly(FOUR);
    const clean = await runAt(M, null);
    expect(clean.r.outcome).toBe('recorded');
    const base = await snapshot();

    await freshDb();
    await recordOnly(FOUR);
    const { r, fake } = await runAt(M, refuse(401, REFUSAL_BODY));
    expect(r.outcome).toBe('recorded');
    expect(fake.callsFor('AAPL').map((c) => c.start)).toEqual([M]); // no catch-up page for it
    expect(fake.callsFor('BTC').length).toBe(2);
    const snap = await snapshot();
    expect(without(snap, 'AAPL')).toEqual(without(base, 'AAPL'));
    expect(await rows("SELECT t, state, tries FROM candles_1m WHERE feed = 'AAPL'")).toEqual([{ t: M, state: 'incomplete', tries: 1 }]);
    expect(await rows("SELECT * FROM latest WHERE feed = 'AAPL'")).toEqual([]);
    expect(await rows('SELECT unauthorized, key_failure FROM runs')).toEqual([{ unauthorized: '["AAPL"]', key_failure: 0 }]);
    expect(await rows('SELECT symbol, source FROM feed_holds')).toEqual([{ symbol: 'AAPL', source: 'tick' }]);
  });

  it('403 with the refusal body behaves the same (synthetic status)', async () => {
    await recordOnly(FOUR);
    const { r, fake } = await runAt(M, refuse(403, REFUSAL_BODY));
    expect(r.run?.unauthorized).toEqual(['AAPL']);
    expect(r.run?.key_failure).toBe(0);
    expect(fake.callsFor('AAPL').length).toBe(1);
    expect(await rows('SELECT symbol, source FROM feed_holds')).toEqual([{ symbol: 'AAPL', source: 'tick' }]);
  });

  it('the hold is add-only: a second refused tick adds nothing; an operator hold keeps its since and source; a feed that answers 200 again is recorded and keeps its hold', async () => {
    await recordOnly(FOUR);
    await runAt(M, refuse(401, REFUSAL_BODY));
    const first = await rows('SELECT * FROM feed_holds');
    await runAt(M + 60, refuse(401, REFUSAL_BODY));
    expect(await rows('SELECT * FROM feed_holds')).toEqual(first);
    expect((await rows('SELECT unauthorized FROM runs ORDER BY t')).map((x) => x.unauthorized)).toEqual(['["AAPL"]', '["AAPL"]']);
    const { fake } = await runAt(M + 120, null);
    expect(fake.callsFor('AAPL').length).toBeGreaterThan(0);
    // The minute left incomplete by the refusal is caught up from the real page once AAPL answers again.
    expect(await rows("SELECT state, tries FROM candles_1m WHERE feed = 'AAPL' AND t = ?1", M)).toEqual([{ state: 'open', tries: 1 }]);
    expect(await rows('SELECT * FROM feed_holds')).toEqual(first);
    expect((await rows('SELECT unauthorized FROM runs ORDER BY t DESC LIMIT 1'))[0].unauthorized).toBe('[]');

    await freshDb();
    await recordOnly(FOUR);
    await env.DB.prepare("INSERT INTO feed_holds (symbol, since, source) VALUES ('AAPL', 123, 'operator')").run();
    await runAt(M, refuse(401, REFUSAL_BODY));
    expect(await rows('SELECT * FROM feed_holds')).toEqual([{ symbol: 'AAPL', since: 123, source: 'operator' }]);
  });

  it('the hold and the runs row are written in the tick batch: an aborted batch writes neither', async () => {
    await recordOnly(FOUR);
    await env.DB.prepare('DROP TABLE feed_holds').run();
    const { r } = await runAt(M, refuse(401, REFUSAL_BODY));
    expect(r.outcome).toBe('batch_failed');
    expect(await rows('SELECT * FROM runs')).toEqual([]);
    expect(await rows('SELECT * FROM candles_1m')).toEqual([]);
  });

  it('a feed in config.feeds_refused gets only its one hourly restoration probe, no row and no todo unit', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    const { fake } = await runAt(M, null); // M is 15:00 UTC: the hourly gap-scan tick
    const listed = FEEDS.filter((f) => f.symbol !== 'BTC' && f.symbol !== 'EURUSD').map((f) => f.feedId);
    const probes = fake.calls.filter((c) => listed.includes(c.feedId as Feed['feedId']));
    expect(probes.map((c) => c.feedId).sort()).toEqual([...listed].sort()); // exactly one call each
    expect(probes.every((c) => c.limit === 1)).toBe(true);
    expect(probes.every((c) => c.start >= M + 90 - 120 && c.start <= M + 90 + 45 - 120)).toBe(true); // from now - 120, within the call window
    expect(new Set(fake.calls.filter((c) => !listed.includes(c.feedId as Feed['feedId'])).map((c) => c.feedId.slice(0, 10)))).toEqual(new Set(['0x00037da0', '0x0008a5f1']));
    expect((await rows('SELECT DISTINCT feed FROM candles_1m ORDER BY feed')).map((x) => x.feed)).toEqual(['BTC', 'EURUSD']);
    expect((await rows('SELECT DISTINCT feed FROM todo ORDER BY feed')).map((x) => x.feed)).toEqual(['BTC', 'EURUSD']);
  });
});

describe('whole-key failure (plan 4.1)', () => {
  it('401 with another error text (a real 400 body, synthetic status): no further call in the tick, key_failure, nothing listed, no hold', async () => {
    await recordOnly(['BTC']);
    const { r, fake } = await runAt(M, () => ({ status: 401, body: OTHER_ERROR_BODY }));
    expect(fake.calls.length).toBe(1);
    expect(r.run).toMatchObject({ calls: 1, key_failure: 1, unauthorized: [] });
    expect(await rows('SELECT * FROM feed_holds')).toEqual([]);
    expect(await rows("SELECT t, state FROM candles_1m WHERE feed = 'BTC'")).toEqual([{ t: M, state: 'incomplete' }]);
  });

  it('403 without a body, and 401 whose body is not JSON, are whole-key failures too', async () => {
    for (const [status, body] of [[403, ''], [401, 'Unauthorized']] as const) {
      await freshDb();
      await recordOnly(['BTC']);
      const { r } = await runAt(M, () => ({ status, body }));
      expect(r.run?.key_failure, `${status} ${body}`).toBe(1);
    }
  });

  it('every answered live page a per-feed refusal: a whole-key failure, nothing excluded, no hold, no catch-up', async () => {
    await recordOnly(FOUR);
    const { r, fake } = await runAt(M, () => ({ status: 401, body: REFUSAL_BODY }));
    expect(fake.calls.length).toBe(4);
    expect(fake.calls.every((c) => c.start === M)).toBe(true);
    expect(r.run).toMatchObject({ key_failure: 1, unauthorized: [] });
    expect(await rows('SELECT * FROM feed_holds')).toEqual([]);
  });

  it('every ANSWERED live page refused while another feed got no answer (network error, synthetic): still a whole-key failure, and that feed gets no catch-up call', async () => {
    await recordOnly(FOUR);
    const { r, fake } = await runAt(M, (c) => {
      if (c.feedId.startsWith('0x00037da0')) throw new TypeError('network down');
      return { status: 401, body: REFUSAL_BODY };
    });
    expect(r.run).toMatchObject({ key_failure: 1, unauthorized: [] });
    expect(fake.callsFor('BTC').map((c) => c.start)).toEqual([M]);
    expect(fake.calls.length).toBe(4);
    expect(await rows('SELECT * FROM feed_holds')).toEqual([]);
  });

  it('a 429 stops every further call: n_429 = 1, no catch-up page, the feed refused by the limit stays incomplete', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    const { r, fake } = await runAt(M, (c) => (c.feedId.startsWith('0x00037da0') ? { status: 429, body: '' } : null));
    expect(r.run).toMatchObject({ n_429: 1, key_failure: 0, unauthorized: [] });
    expect(fake.calls.every((c) => c.start === M)).toBe(true);
    expect(fake.calls.length).toBeLessThanOrEqual(2);
    expect(await rows("SELECT state FROM candles_1m WHERE feed = 'BTC'")).toEqual([{ state: 'incomplete' }]);
  });

  it('a 5xx on one feed is that feed\'s failed call only: the others go on, nothing halts', async () => {
    await recordOnly(['BTC', 'EURUSD']);
    const { r, fake } = await runAt(M, (c) => (c.feedId.startsWith('0x00037da0') && c.start === M ? { status: 503, body: 'x' } : null));
    expect(r.run).toMatchObject({ n_429: 0, key_failure: 0 });
    expect(fake.callsFor('EURUSD').length).toBe(2);
    expect(fake.callsFor('BTC').map((c) => c.start)).toEqual([M, M - 600]);
  });
});
