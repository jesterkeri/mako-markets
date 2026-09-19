import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runOnce, type Deps } from '../src/run';
import { closedMarket, makeDeps, makeWorld, type FakeMarket, type World } from './fake';

let n = 0;
function freshState(): Deps['state'] {
  const s = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName(`run-test-${n++}`));
  return { acquire: (a, b) => s.acquire(a, b), commit: (t, a, p) => s.commit(t, a, p) };
}

const FIVE_MIN = 300_000;

/// Runs one cron tick at the world's current time, then moves the clock to the next tick.
async function tick(w: World, state: Deps['state'], logs: string[] = []) {
  const scheduled = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
  w.pageRequestIndex = 0;
  w.latestBlock += 600;
  w.finalizedBlock += 600;
  const r = await runOnce(makeDeps(w, state, logs), scheduled);
  w.clock.t = scheduled + FIVE_MIN + 1_000;
  return r;
}

const nowS = (w: World) => Math.floor(w.clock.t / 1000);

function openMarket(mType: number, ref: string, w: World, yes = 1_000_000n, no = 0n): FakeMarket {
  const created = nowS(w) - 600;
  return { mType, ref, createdAt: created, closeTime: created + 86_400, bettingCloseTime: created + 43_200, yes, no, resolved: false };
}

describe('first run (bootstrap)', () => {
  it('reads every market, snapshots resolutions, queues nothing, reports once', async () => {
    const w = makeWorld();
    const t = nowS(w);
    w.markets = [
      closedMarket(1, 'ETH:lt:1827', t, 40 * 86_400, 5_000_000n, 5_000_000n, true),
      closedMarket(6, 'political1', t, 30 * 86_400, 300_000n, 0n, true),
      openMarket(1, 'SOL:gt:102', w),
    ];
    const state = freshState();
    const r = await tick(w, state);
    expect(r.kind).toBe('completed');
    expect(r.committed).toBe(true);
    expect(r.effective).toBe(true);
    expect(r.ping).toBe('success');
    expect(r.payload!.meta).toMatchObject({ creationCursor: 3, bootstrapN: 3, resolvedBootstrapped: true });
    expect(r.payload!.auditAppend).toEqual([]);
    expect(w.telegram.sent.join('\n')).toContain('Resolved before the watchdog, not audited (2): 0-1');
    expect(r.httpRequests + r.doCalls).toBeLessThanOrEqual(24);

    // Second run: nothing new to say.
    w.telegram.sent = [];
    const r2 = await tick(w, state);
    expect(r2.effective).toBe(true);
    expect(w.telegram.sent).toEqual([]);
  });
});

describe('stuck markets and commands', () => {
  it('one-sided past +24h gets a command; two-sided gets "no safe refund path" and no command', async () => {
    const w = makeWorld();
    const t = nowS(w);
    w.markets = [
      closedMarket(1, 'LINK:gt:20', t, 2 * 86_400, 1_000_000n, 0n), // 0: one-sided
      closedMarket(4, 'XAUUSD:lt:2400', t, 2 * 86_400, 1_000_000n, 2_000_000n), // 1: two-sided
      closedMarket(5, 'AAPL:gt:200', t, 2 * 3600, 1_000_000n, 0n), // 2: one-sided, refund not open yet
    ];
    const state = freshState();
    const r = await tick(w, state);
    const text = w.telegram.sent.join('\n');
    expect(text).toContain('#0 CRYPTO one-sided, unresolved 2d 0h after close');
    expect(text).toContain('#1 COMMODITIES two-sided, unresolved 2d 0h after close (YES 1.00 / NO 2.00): no safe refund path on V4');
    expect(text).toContain('#2 STOCKS one-sided, unresolved 2h after close (YES 1.00 / NO 0.00): refund opens');
    expect(text).toContain('for id in 0; do cast send');
    expect(text).not.toMatch(/for id in [^;]*\b1\b/);
    expect(text).toContain('manifest ids: 0-2 | checks: -');
    expect(r.effective).toBe(true);
  });

  it('an undelivered critical is re-sent next run, and the run pings /fail', async () => {
    // 07:05 UTC: before the 08:00 digest, so the only S3 cause is the critical.
    const w = makeWorld({ clock: { t: Date.UTC(2026, 8, 19, 7, 5) }, telegram: { mode: 'fail', retryAfter: 1, sent: [] } });
    w.markets = [closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 3600, 1_000_000n, 0n)];
    const state = freshState();
    const r1 = await tick(w, state);
    expect(r1.ping).toBe('fail');
    expect(r1.failed).toEqual(['S3']);
    expect(r1.s3Reasons).toEqual(['critical undelivered']);
    expect(r1.committed).toBe(true);
    expect(r1.healthchecksBody).toContain('manifest ids: 0 | checks: tg');
    w.telegram.mode = 'ok';
    const r2 = await tick(w, state);
    expect(w.telegram.sent.join('\n')).toContain('#0 CRYPTO one-sided');
    expect(r2.ping).toBe('success');
    // Delivered: not repeated until the 6-hour reminder.
    w.telegram.sent = [];
    await tick(w, state);
    expect(w.telegram.sent.join('\n')).not.toContain('#0 CRYPTO');
    w.clock.t += 6 * 3600_000;
    await tick(w, state);
    expect(w.telegram.sent.join('\n')).toContain('#0 CRYPTO');
  });
});

describe('UO: unsupported oracle reference', () => {
  it('is critical on every read until the market resolves, and says PUBLIC', async () => {
    const w = makeWorld();
    w.markets = [openMarket(1, 'PEPE:gt:1', w), openMarket(6, 'anything goes', w)];
    const state = freshState();
    const r = await tick(w, state);
    const text = w.telegram.sent.join('\n');
    expect(text).toContain('#0 PUBLIC market (CRYPTO): oracle reference not supported, the resolver cannot settle it; betting open until');
    expect(text).not.toContain('#1 PUBLIC');
    expect(text).toContain('checks: uo');
    expect(r.payload!.criticals.map((c) => c.key)).toEqual(['u:0']);
    w.markets[0] = { ...w.markets[0], resolved: true };
    const r2 = await tick(w, state);
    expect(r2.payload!.criticals).toEqual([]);
  });
});

describe('creation cursor over whole runs', () => {
  it('a new paused-symbol market is alerted; an unconfirmed alert holds the cursor and repeats', async () => {
    const w = makeWorld();
    w.markets = [openMarket(1, 'BTC:gt:100000', w)];
    const state = freshState();
    await tick(w, state);
    w.markets.push(openMarket(5, 'KO:gt:60', w));
    w.telegram.mode = 'fail';
    const r1 = await tick(w, state);
    expect(r1.payload!.meta.creationCursor).toBe(1);
    expect(r1.payload!.meta.creationPendingSince).not.toBeNull();
    w.telegram.mode = 'ok';
    const r2 = await tick(w, state);
    expect(w.telegram.sent.join('\n')).toContain('NEW #1 STOCKS KO: paused symbol, no verified Data Streams feed');
    expect(r2.payload!.meta.creationCursor).toBe(2);
    expect(r2.payload!.meta.creationPendingSince).toBeNull();
    w.telegram.sent = [];
    await tick(w, state);
    expect(w.telegram.sent.join('\n')).not.toContain('NEW #1');
  });

  it('a failed middle page holds the cursor at its first id; the next run catches up', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = Array.from({ length: 10 }, () => openMarket(1, 'BTC:gt:100000', w));
    await tick(w, state);
    // 450 new markets: pages of 200 ids; the page holding ids 210-409 fails.
    for (let i = 0; i < 450; i++) w.markets.push(openMarket(1, 'BTC:gt:100000', w));
    w.markets[300] = openMarket(3, 'EURJPY:gt:160', w); // paused symbol inside the failed page
    w.failPages = new Set([1]);
    const r = await tick(w, state);
    expect(r.failed).toContain('S1');
    expect(r.payload!.meta.creationCursor).toBe(210);
    expect(w.telegram.sent.join('\n')).not.toContain('NEW #300');
    w.failPages = new Set();
    const r2 = await tick(w, state);
    expect(w.telegram.sent.join('\n')).toContain('NEW #300 FOREX EURJPY');
    expect(r2.payload!.meta.creationCursor).toBe(460);
  });

  it('one failed call inside aggregate3 stops the cursor at that id', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w)];
    await tick(w, state);
    for (let i = 0; i < 5; i++) w.markets.push(openMarket(1, 'BTC:gt:1', w));
    w.failIds = new Set([3]);
    const r = await tick(w, state);
    expect(r.payload!.meta.creationCursor).toBe(3);
    expect(r.failed).toContain('S1');
  });

  it('a deadline stop commits nothing: the cursor and resolved set are unchanged', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w)];
    await tick(w, state);
    w.markets.push(openMarket(1, 'BTC:gt:1', w));
    w.latencyMs = 70_000; // three requests pass the 200 s deadline
    const r = await tick(w, state);
    expect(r.kind).toBe('deadline');
    expect(r.committed).toBe(false);
    expect(w.hc.pings.length).toBe(1); // only the first run's ping
    w.latencyMs = 20;
    w.clock.t += FIVE_MIN; // the stale lease (270 s) has expired
    const r2 = await tick(w, state);
    expect(r2.payload!.meta.creationCursor).toBe(2);
  });

  it('a lease held by another run: skipped with /log, nothing read', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w)];
    const scheduled = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
    await state.acquire(scheduled - FIVE_MIN, w.clock.t); // another run holds it
    const r = await runOnce(makeDeps(w, state), scheduled);
    expect(r.kind).toBe('skipped');
    expect(r.ping).toBe('log');
    expect(w.hc.pings[0].url).toMatch(/\/log$/);
    expect(w.log.filter((l) => l.startsWith('providerb'))).toEqual([]);
  });
});

describe('N read at a later block than the pages', () => {
  it('a zero market below N is unread: the cursor stops there and the run is ineffective', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w), openMarket(1, 'BTC:gt:1', w)];
    await tick(w, state);
    w.reportedN = 4; // ids 2 and 3 do not exist yet at the page block
    const r = await tick(w, state);
    expect(r.payload!.meta.creationCursor).toBe(2);
    expect(r.failed).toContain('S1');
  });
});

describe('the daily digest', () => {
  it('is sent once a day from 08:00 UTC; undelivered past 08:30 makes runs ineffective', async () => {
    const w = makeWorld({ clock: { t: Date.UTC(2026, 8, 19, 7, 55, 1) } });
    const state = freshState();
    await tick(w, state);
    expect(w.telegram.sent.join('\n')).not.toContain('DAILY DIGEST');
    w.telegram.mode = 'fail';
    for (let i = 0; i < 7; i++) await tick(w, state); // 08:00 to 08:30
    const late = await tick(w, state); // 08:35
    expect(late.s3Reasons).toContain('non-critical waiting over 30 min');
    w.telegram.mode = 'ok';
    const r = await tick(w, state);
    expect(w.telegram.sent.join('\n')).toContain('DAILY DIGEST');
    expect(r.payload!.meta.lastDigestDate).toBe('2026-09-19');
    w.telegram.sent = [];
    await tick(w, state);
    expect(w.telegram.sent.join('\n')).not.toContain('DAILY DIGEST');
  });
});

describe('discovery (I8a part a)', () => {
  it('each resolution is queued once, including across an outage and a killed run', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w), openMarket(1, 'ETH:gt:1', w), openMarket(6, 'x', w)];
    await tick(w, state); // bootstrap: nothing resolved
    w.markets[0] = { ...w.markets[0], resolved: true, outcome: 1 }; // resolver
    w.markets[2] = { ...w.markets[2], resolved: true, outcome: 3 }; // owner or forceRefund
    w.clock.t += 6 * 3600_000; // outage of several hours
    w.latencyMs = 70_000; // this run is killed by the deadline
    const killed = await tick(w, state);
    expect(killed.committed).toBe(false);
    w.latencyMs = 20;
    w.clock.t += FIVE_MIN;
    const r = await tick(w, state);
    expect(r.payload!.auditAppend.map((a) => a.marketId)).toEqual([0, 2]);
    const r2 = await tick(w, state);
    expect(r2.payload!.auditAppend).toEqual([]);
  });

  it('a partial first read does not bootstrap', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w), { ...openMarket(1, 'BTC:gt:1', w), resolved: true }];
    w.failIds = new Set([1]);
    const r = await tick(w, state);
    expect(r.payload!.meta.resolvedBootstrapped).toBe(false);
    w.failIds = new Set();
    const r2 = await tick(w, state);
    expect(r2.payload!.meta.resolvedBootstrapped).toBe(true);
    expect(w.telegram.sent.join('\n')).toContain('not audited (1): 1');
  });
});

describe('probes and checks', () => {
  it('a failing probe alerts only after two observations (flap control)', async () => {
    const w = makeWorld();
    const state = freshState();
    w.publicDown = true;
    const r1 = await tick(w, state);
    expect(r1.payload!.criticals).toEqual([]);
    const r2 = await tick(w, state);
    expect(r2.payload!.criticals.map((c) => c.key)).toEqual(['c:rr']);
    w.publicDown = false;
    await tick(w, state);
    const r4 = await tick(w, state);
    expect(r4.payload!.criticals).toEqual([]);
    expect(w.telegram.sent.join('\n')).toContain('RECOVERED rr');
  });

  it('minute 0 runs the comments, market-page and charts probes; charts failing is a warning', async () => {
    const w = makeWorld({ clock: { t: Date.UTC(2026, 8, 19, 13, 0, 1) } });
    w.app.charts = false;
    const state = freshState();
    await tick(w, state);
    w.clock.t = Date.UTC(2026, 8, 19, 14, 0, 1);
    const r = await tick(w, state);
    expect(w.log.filter((l) => l.includes('/api/comments')).length).toBe(2);
    expect(w.log.filter((l) => l.includes('/market/74')).length).toBe(2);
    expect(r.payload!.warnings.map((x) => x.key)).toContain('c:ch');
    expect(r.payload!.criticals).toEqual([]);
    expect(w.telegram.sent.join('\n')).toContain('WARN CHECK ch: charts API: http 502');
  });

  it('provider B down makes the run ineffective and keeps stored market criticals', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 3600, 1_000_000n, 0n)];
    await tick(w, state);
    w.providerDown = true;
    const r = await tick(w, state);
    expect(r.failed).toContain('S1');
    expect(r.ping).toBe('log');
    expect(r.payload!.criticals.map((c) => c.key)).toEqual(['m:0']);
    expect(r.payload!.meta.creationCursor).toBe(1);
  });

  it('a changed resolver address is critical, and an unread chain is never a recovery', async () => {
    const w = makeWorld({ resolver: '0x00000000000000000000000000000000000000bb', balanceWei: 10n ** 17n });
    const state = freshState();
    const r = await tick(w, state);
    expect(w.telegram.sent.join('\n')).toContain('CHECK rv: resolver() is 0x00000000000000000000000000000000000000bb');
    expect(w.telegram.sent.join('\n')).toContain('balance 0.10 MON, below 0.50');
    expect(r.payload!.criticals.map((c) => c.key)).toEqual(['c:rv']);
    w.providerDown = true;
    const r2 = await tick(w, state);
    expect(r2.payload!.criticals.map((c) => c.key)).toEqual(['c:rv']);
    expect(r2.payload!.warnings.map((x) => x.key)).toEqual(['bal']);
    expect(w.telegram.sent.join('\n')).not.toContain('RECOVERED');
    w.providerDown = false;
    w.resolver = '0xc8bf886f73e4371cbd8160eea7683b8da98190f1';
    w.balanceWei = 19n * 10n ** 18n;
    await tick(w, state);
    expect(w.telegram.sent.join('\n')).toContain('RECOVERED rv');
    expect(w.telegram.sent.join('\n')).toContain('RECOVERED resolver balance');
  });

  it('past 2,000 markets the run is ineffective with the envelope critical', async () => {
    const w = makeWorld();
    const base = openMarket(1, 'BTC:gt:1', w);
    w.markets = Array.from({ length: 2001 }, () => base);
    const r = await tick(w, freshState());
    expect(r.failed).toContain('S7');
    expect(r.payload!.criticals.map((c) => c.key)).toContain('c:se');
    expect(r.plan!.ids.length).toBe(2000);
  });
});

describe('timing and budget', () => {
  it('every request timing out still ends well before the 200 s deadline, and progress is kept', async () => {
    const w = makeWorld({ clock: { t: Date.UTC(2026, 8, 19, 13, 0, 1) }, allTimeout: true });
    const state = freshState();
    const t0 = w.clock.t;
    const r = await runOnce(makeDeps(w, state), Math.floor(t0 / FIVE_MIN) * FIVE_MIN);
    expect(r.kind).toBe('completed');
    expect(r.committed).toBe(true);
    expect(r.failed).toContain('S1');
    expect(w.log.length).toBeLessThanOrEqual(22);
    expect(w.clock.t - t0).toBeLessThan(200_000);
    expect(w.hc.pings).toHaveLength(0); // the ping itself timed out: not accepted, Healthchecks goes Down after grace
    expect(r.pingAccepted).toBe(false);
  });

  it('2,000 markets at minute 0 with 9 s per request (time serialised, which overstates the parallel parts) completes within budget', async () => {
    const w = makeWorld({ clock: { t: Date.UTC(2026, 8, 19, 13, 0, 1) } });
    const base = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 2000 }, () => base);
    w.latencyMs = 9_000;
    const logs: string[] = [];
    const t0 = w.clock.t;
    const r = await runOnce(makeDeps(w, freshState(), logs), Math.floor(t0 / FIVE_MIN) * FIVE_MIN);
    expect(r.kind).toBe('completed');
    expect(r.committed).toBe(true);
    expect(r.httpRequests + r.doCalls).toBeLessThanOrEqual(24);
    expect(w.log.filter((l) => l.startsWith('providerb')).length).toBe(11);
    expect(w.clock.t - t0).toBeLessThan(200_000);
    expect(r.telegramMessages.length).toBeLessThanOrEqual(4);
    // The full manifest carries all 2,000 ids.
    expect(r.telegramMessages.join('\n').replace(/\n/g, '')).toContain('manifest ids: 0-1999');
  });
});

describe('secrets never reach alerts or Healthchecks', () => {
  it('provider B key, Telegram token and check URL stay out of every message and body', async () => {
    const w = makeWorld();
    w.markets = [closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n)];
    w.providerDown = true;
    const logs: string[] = [];
    const state = freshState();
    await tick(w, state, logs);
    await tick(w, state, logs);
    const everything = [...w.telegram.sent, ...w.hc.pings.map((p) => p.body), ...logs].join('\n');
    expect(everything).not.toContain('SECRET-KEY');
    expect(everything).not.toContain('TELEGRAM-TOKEN');
    expect(everything).not.toContain('0000-uuid');
  });
});
