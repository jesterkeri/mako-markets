import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { LEASE_MS } from '../src/config';
import { runOnce, type Deps } from '../src/run';
import { closedMarket, makeDeps, makeWorld, MAKO as MAKO_ADDR, RESOLVER as RES_ADDR, type FakeMarket, type World } from './fake';

let n = 0;
type TestState = Deps['state'] & { age: (ms?: number) => Promise<void> };
function freshState(): TestState {
  const s = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName(`run-test-${n++}`));
  return {
    acquire: (a) => s.acquire(a),
    commit: (t, a, p) => s.commit(t, a, p),
    /// Time passing, for the one clock a test cannot set: lease expiry is the
    /// Durable Object's own (`src/state.ts`), so the world clock moving does
    /// not free a lease left behind by a killed run. This ages the stored
    /// expiry, which is what real elapsed time does to it.
    age: async (ms = LEASE_MS) => {
      await runInDurableObject(s, (_i, st) => {
        st.storage.sql.exec('UPDATE lease SET expires_at = expires_at - ? WHERE id = 1', ms);
      });
    },
  };
}

const FIVE_MIN = 300_000;

/// Runs one cron tick at the world's current time, then moves the clock to the next tick.
async function tick(w: World, state: Deps['state'], logs: string[] = []) {
  const scheduled = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
  w.pageRequestIndex = 0;
  w.latestBlock += 600;
  w.finalizedBlock += 600;
  w.finalizedTs = Math.floor(w.clock.t / 1000);
  const r = await runOnce(makeDeps(w, state, logs), scheduled);
  w.clock.t = scheduled + FIVE_MIN + 1_000;
  return r;
}

const nowS = (w: World) => Math.floor(w.clock.t / 1000);

/// Market ids listed in a refund command, if any.
function commandIdsIn(text: string): number[] {
  const m = text.match(/for id in ([\d ]+); do/);
  return m ? m[1].trim().split(' ').map(Number) : [];
}

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
    expect(r.httpRequests + r.doCalls).toBeLessThanOrEqual(32); // the bootstrap run's ceiling

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
    // 250 ids to cross; the second source confirms 200 a run. Deferred cursor
    // ids are unfinished required work: ineffective until caught up (review r3).
    expect(r2.payload!.meta.creationCursor).toBe(410);
    expect(r2.failed).toContain('S1');
    const r3 = await tick(w, state);
    expect(r3.payload!.meta.creationCursor).toBe(460);
    expect(r3.effective).toBe(true);
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
    w.clock.t += FIVE_MIN;
    await state.age(); // the stale lease (270 s) has expired
    const r2 = await tick(w, state);
    expect(r2.payload!.meta.creationCursor).toBe(2);
  });

  it('a lease held by another run: skipped with /log, nothing read', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w)];
    const scheduled = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
    await state.acquire(scheduled - 60_000); // another run holds it, 60 s ago
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
    await state.age(); // the killed run's lease has expired
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
    const state = freshState();
    await tick(w, state); // bootstrap first: this measures an ordinary run
    w.latencyMs = 9_000;
    w.log = [];
    const logs: string[] = [];
    const t0 = w.clock.t;
    const r = await runOnce(makeDeps(w, state, logs), Math.floor(t0 / FIVE_MIN) * FIVE_MIN);
    expect(r.kind).toBe('completed');
    expect(r.committed).toBe(true);
    expect(r.httpRequests + r.doCalls).toBeLessThanOrEqual(32); // the bootstrap run's ceiling
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

// Review r1 finding 1: provider B's identity and clock are validity gates.
describe('provider B identity and time gate (fail closed)', () => {
  /// A market that looks refundable to provider B.
  function refundableWorld(partial: Partial<World> = {}) {
    const w = makeWorld(partial);
    w.markets = [closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n)];
    return w;
  }
  async function expectRejected(w: World, reason: RegExp) {
    const state = freshState();
    const r = await tick(w, state);
    expect(r.failed).toContain('S1'); // at once, not after flap control
    expect(r.plan).toBeNull(); // no pages read
    expect(r.payload!.criticals).toEqual([]);
    expect(r.payload!.meta).toMatchObject({ creationCursor: 0, bootstrapN: null, resolvedBootstrapped: false, lastLatestBlock: null });
    expect(r.payload!.resolvedBits).toBe('');
    expect(w.telegram.sent.join('\n')).not.toContain('cast send');
    expect(w.log.filter((l) => l.endsWith(' page'))).toEqual([]);
    expect(r.healthchecksBody).toMatch(reason);
    expect(r.ping).toBe('log');
  }
  it('wrong chain id on the first observation', async () => {
    await expectRejected(refundableWorld({ providerChainId: 1 }), /provider B: wrong chain 1/);
  });
  it('finalized time an hour in the future', async () => {
    await expectRejected(refundableWorld({ providerTimestampOffsetS: 3600 }), /in the future/);
  });
  it('finalized time an hour old (chain halted or provider behind)', async () => {
    await expectRejected(refundableWorld({ providerTimestampOffsetS: -3600 }), /stale/);
  });
  it('finalized block ahead of latest', async () => {
    await expectRejected(refundableWorld({ providerFinalizedOverride: 63_900_000, providerLatestOverride: 63_000_000 }), /ahead of latest/);
  });
  it('a block number beyond a safe integer', async () => {
    await expectRejected(refundableWorld({ providerLatestOverride: 2 ** 60 }), /bad_response/);
  });
  it('a second inside each bound (60 s ahead, 15 min behind) is accepted; a second outside is not', async () => {
    for (const [offset, ok] of [[59, true], [61, false], [-899, true], [-901, false]] as const) {
      const w = refundableWorld({ providerTimestampOffsetS: offset });
      const r = await tick(w, freshState());
      expect(r.plan !== null).toBe(ok);
    }
  });
  it('one huge-but-plausible block number does not pin the advancing check', async () => {
    const w = makeWorld();
    const state = freshState();
    await tick(w, state);
    w.providerLatestOverride = 900_000_000;
    w.providerFinalizedOverride = 899_999_998;
    await tick(w, state);
    w.providerLatestOverride = undefined;
    w.providerFinalizedOverride = undefined;
    const r3 = await tick(w, state); // one "not advancing" observation
    expect(r3.payload!.meta.lastLatestBlock).toBe(w.latestBlock);
    const r4 = await tick(w, state);
    const r5 = await tick(w, state);
    expect(r4.payload!.checks.find((c) => c.code === 'pb')!.state).toBe('ok');
    expect(r5.payload!.criticals).toEqual([]);
  });
});

describe('refund commands need the public RPC to confirm at the same block (I7)', () => {
  function world(partial: Partial<World> = {}) {
    const w = makeWorld(partial);
    w.markets = [closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n)];
    return w;
  }
  it('confirmed: the command is printed', async () => {
    const w = world();
    const r = await tick(w, freshState());
    expect(w.telegram.sent.join('\n')).toContain('for id in 0; do cast send');
    expect(r.healthchecksBody).toContain('refund commands 1/1');
  });
  it.each([
    ['public RPC down', { publicDown: true }, /public RPC http/],
    ['public RPC on another chain', { publicChainId: 1 }, /public RPC chain id/],
    ['public RPC reports another block', { publicBlockHash: '0x' + '22'.repeat(32) }, /public RPC block differs/],
  ] as [string, Partial<World>, RegExp][])('%s: withheld', async (_label, partial, reason) => {
    const w = world(partial);
    const r = await tick(w, freshState());
    const text = w.telegram.sent.join('\n');
    expect(text).not.toContain('cast send');
    expect(text).toContain('#0 CRYPTO one-sided');
    expect(text).toContain('refund command withheld');
    expect(r.healthchecksBody).toMatch(reason);
  });
  it('public RPC sees different pools, another close time, or an already resolved market: withheld', async () => {
    const w0 = world();
    for (const pub of [
      { yes: 1_000_000n, no: 5n, resolved: false },
      { yes: 1_000_000n, no: 0n, resolved: true },
      // Still one-sided and past +24h on the public RPC, but not the same market state:
      { yes: 2_000_000n, no: 0n, resolved: false },
      { closeTime: nowS(w0) - 3 * 86_400, resolved: false },
    ]) {
      const w = world();
      w.publicMarkets = [{ ...w.markets[0], ...pub }];
      await tick(w, freshState());
      expect(w.telegram.sent.join('\n')).not.toContain('cast send');
      expect(w.telegram.sent.join('\n')).toContain('refund command withheld');
    }
  });
});

// Review r8: REMOVING a delivered market critical is a one-way suppression, so
// it needs the same second source its creation would need. Otherwise a
// provider B that answers "resolved" or "healthy" for a market it is lying
// about deletes the alert and the watchdog goes quiet, with no refund command
// ever produced and no recovery note sent.
describe('clearing a critical needs the second source (review r8)', () => {
  it('a fabricated resolution does not clear a stored UO', async () => {
    const w = makeWorld();
    const state = freshState();
    const real = openMarket(1, 'PEPE:gt:1', w); // no such crypto symbol: UO
    w.markets = [real];
    const r1 = await tick(w, state);
    expect(r1.payload!.criticals.map((c) => c.key)).toEqual(['u:0']);
    expect(w.telegram.sent.join('\n')).toContain('#0 PUBLIC market (CRYPTO)');

    // Provider B now claims the market resolved; the public RPC says it did not.
    w.markets = [{ ...real, resolved: true, outcome: 1 }];
    w.publicMarkets = [real];
    const r2 = await tick(w, state);
    expect(r2.payload!.criticals.map((c) => c.key)).toEqual(['u:0']); // still there
    expect(r2.payload!.resolvedBits.replace(/0/g, '')).toBe(''); // and no bit set
    expect(r2.failed).toContain('S1');

    // Provider B tells the truth: the resolution clears it.
    w.markets = [{ ...real, resolved: true, outcome: 1 }];
    w.publicMarkets = undefined;
    const r3 = await tick(w, state);
    expect(r3.payload!.criticals.map((c) => c.key)).toEqual([]);
  });

  it('a fabricated healthy head does not clear a stored stuck-market critical', async () => {
    const w = makeWorld();
    const state = freshState();
    const stuck = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = [stuck];
    const r1 = await tick(w, state);
    expect(r1.payload!.criticals.map((c) => c.key)).toEqual(['m:0']);

    // Provider B moves the close time into the future, so the market reads as
    // healthy and never becomes a resolution transition. The public RPC still
    // returns the real head.
    w.markets = [{ ...stuck, closeTime: nowS(w) + 86_400, bettingCloseTime: nowS(w) + 43_200 }];
    w.publicMarkets = [stuck];
    const r2 = await tick(w, state);
    expect(r2.payload!.criticals.map((c) => c.key)).toEqual(['m:0']);
    // And it is not demoted to a warning on the strength of the same head.
    expect(r2.payload!.warnings.map((x) => x.key)).not.toContain('w:0');

    // Both sources agree it is healthy: now it clears.
    w.markets = [{ ...stuck, closeTime: nowS(w) + 86_400, bettingCloseTime: nowS(w) + 43_200 }];
    w.publicMarkets = undefined;
    const r3 = await tick(w, state);
    expect(r3.payload!.criticals.map((c) => c.key)).toEqual([]);
  });

  it('an unconfirmed head cannot turn a runnable refund command into "no safe refund path"', async () => {
    // Review r9: r8 gated only CLEARING a critical. A head that keeps the
    // market critical can still take the safe action away.
    const w = makeWorld();
    const state = freshState();
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = [oneSided];
    const r1 = await tick(w, state);
    expect(commandIdsIn(w.telegram.sent.join('\n'))).toEqual([0]); // confirmed and delivered
    expect(r1.payload!.criticals[0].line).toContain('refund command below');

    // Provider B reports the same market at the same block as TWO-SIDED, which
    // in V4 has no safe refund path. The public RPC still says one-sided.
    w.clock.t += 6 * 3600_000; // the reminder is due, so the line is re-sent
    w.telegram.sent = [];
    w.markets = [{ ...oneSided, no: 1n }];
    w.publicMarkets = [oneSided];
    const r2 = await tick(w, state);
    const row = r2.payload!.criticals.find((c) => c.key === 'm:0')!;
    // The confirmed CONDITION is kept, so the false "two-sided" reading cannot
    // replace it (review r9) ...
    expect(row.condition).toContain('one-sided');
    expect(row.line).toContain('one-sided');
    expect(row.line).not.toContain('no safe refund path');
    // ... and the line promises nothing about this run (review r10).
    expect(row.line).toContain('NOT CONFIRMED at this block');
    expect(row.line).not.toContain('refund command below');
    expect(w.telegram.sent.join('\n')).not.toContain('cast send');
    // The market was re-read and the disagreement is reported, not accepted.
    expect(r2.failed).toContain('S1');
    expect(r2.healthchecksBody).toContain('providers disagree at the same block');

    // Provider B tells the truth again: the command comes back on schedule.
    w.telegram.sent = [];
    w.markets = [oneSided];
    w.publicMarkets = undefined;
    await tick(w, state);
    expect(commandIdsIn(w.telegram.sent.join('\n'))).toEqual([0]);
  });

  it('a stored WARNING is protected the same way: an unconfirmed head cannot clear it', async () => {
    // The adversary pass on r9 flagged this as unproven scope: warnings can
    // carry a refund command too, so r9's principle applies to them.
    const w = makeWorld();
    const state = freshState();
    const warnMarket = closedMarket(1, 'LINK:gt:20', nowS(w), 20 * 60, 1_000_000n, 0n);
    w.markets = [warnMarket];
    const r1 = await tick(w, state);
    expect(r1.payload!.warnings.map((x) => x.key)).toEqual(['w:0']);

    // Provider B alone says it resolved. The public RPC says otherwise.
    w.markets = [{ ...warnMarket, resolved: true, outcome: 1 }];
    w.publicMarkets = [warnMarket];
    const r2 = await tick(w, state);
    expect(r2.payload!.warnings.map((x) => x.key)).toEqual(['w:0']);
    expect(r2.payload!.warnings[0].line).toContain('NOT CONFIRMED at this block');
    expect(r2.failed).toContain('S1');

    // Both sources agree it resolved: now it clears.
    w.publicMarkets = undefined;
    const r3 = await tick(w, state);
    expect(r3.payload!.warnings.map((x) => x.key)).toEqual([]);
  });

  it('a row the confirmation budget could not reach says so, and does not blame the provider', async () => {
    // The adversary's secondary finding: past the 200-id budget some stored
    // rows go unverified. They must say which kind of gap it was, in Telegram,
    // not only in the Healthchecks body a success ping never shows.
    const w = makeWorld();
    const state = freshState();
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 250 }, () => oneSided);
    await tick(w, state);
    for (let i = 0; i < 50; i++) w.markets.push(openMarket(1, 'BTC:gt:1', w));
    w.clock.t += 6 * 3600_000; // every reminder is due
    w.telegram.sent = [];
    const r = await tick(w, state);
    const deferredRows = r.payload!.criticals.filter((c) => c.line.includes('not re-checked this run'));
    expect(deferredRows.length).toBeGreaterThan(0); // the budget really did run out
    for (const c of deferredRows) {
      expect(c.line).not.toContain('NOT CONFIRMED'); // budget, not a provider failure
      expect(c.line).not.toContain('refund command below');
    }
    // And it reaches Joshua, not just the stored body: at 250 criticals most
    // lines do not fit, so the count goes in the header, which always does.
    expect(w.telegram.sent.join('\n')).toMatch(/\d+ not re-checked \(block/);
  });

  // Review r10 MAJOR: allocateConfirmations takes a PREFIX of each category,
  // so a fixed order meant the same ids were re-read every run and the tail
  // could stay stale for ever while the run still reported success. The order
  // is now longest-unverified-first, keyed on when each row was last
  // independently confirmed.
  //
  // The condition here changes WITHOUT a resolution, deliberately: a resolved
  // market is a one-way transition and gets confirmed through that category
  // whatever the recovery order does, which would make these tests pass
  // against the very defect they are meant to catch.
  describe('recovery re-reads rotate', () => {
    /// `count` markets that become one-sided warnings (closed 20 minutes ago),
    /// bootstrapped and delivered.
    async function withStoredWarnings(count: number) {
      const w = makeWorld();
      const state = freshState();
      const warnMarket = closedMarket(1, 'LINK:gt:20', nowS(w), 20 * 60, 1_000_000n, 0n);
      w.markets = Array.from({ length: count }, () => warnMarket);
      const r = await tick(w, state);
      expect(r.payload!.warnings.length).toBe(count);
      for (const x of r.payload!.warnings) expect(x.condition).toContain('one-sided');
      return { w, state };
    }

    /// Both providers now see this market as two-sided. The stored condition
    /// may only follow once the id is independently re-read.
    function bothSourcesSeeTwoSided(w: World, id: number) {
      w.markets[id] = { ...w.markets[id], no: 1_000_000n };
    }

    async function runsUntilConditionUpdates(w: World, state: Deps['state'], id: number, cap: number) {
      for (let runs = 1; runs <= cap; runs++) {
        const r = await tick(w, state);
        const row = r.payload!.warnings.find((x) => x.key === `w:${id}`);
        if (row && row.condition?.includes('two-sided')) return runs;
      }
      return Infinity;
    }

    it('re-reads a NON-PREFIX id at 201 stored alerts, which a fixed prefix never reaches', async () => {
      const { w, state } = await withStoredWarnings(201);
      bothSourcesSeeTwoSided(w, 200); // last in id order
      expect(await runsUntilConditionUpdates(w, state, 200, 4)).toBeLessThanOrEqual(4);
    });

    it('re-reads a middle id at the 2,000-market envelope within the rotation bound, with no critical message to carry it', async () => {
      const { w, state } = await withStoredWarnings(2000);
      bothSourcesSeeTwoSided(w, 1000);
      // Every row is an already-delivered warning, so no critical message is
      // built at all: the run's own verdict is the only signal, which is why
      // the bound has to hold on its own.
      expect(await runsUntilConditionUpdates(w, state, 1000, 31)).toBeLessThanOrEqual(31);
    });

    it('serves the longest-unverified rows next, not the same prefix again', async () => {
      const { w, state } = await withStoredWarnings(300);
      const r2 = await tick(w, state); // 200 of 300 re-read
      const at2 = new Map(r2.payload!.warnings.map((x) => [x.key, x.confirmedAt]));
      const fresh2 = [...at2.entries()].filter(([, at]) => at !== null).length;
      expect(fresh2).toBeGreaterThan(0);
      const r3 = await tick(w, state);
      const at3 = new Map(r3.payload!.warnings.map((x) => [x.key, x.confirmedAt]));
      // The tail a fixed prefix would never reach is re-read on the next run.
      expect(at3.get('w:299')).not.toBe(at2.get('w:299'));
      expect(at3.get('w:299')).not.toBe(null);
    });
  });

  it('re-confirming stored criticals costs budget but cannot starve the cursor', async () => {
    const w = makeWorld();
    const state = freshState();
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 60 }, () => oneSided);
    await tick(w, state);
    for (let i = 0; i < 150; i++) w.markets.push(openMarket(1, 'BTC:gt:1', w));
    // 60 stored criticals now share the 200-id budget with 150 cursor ids and
    // the 50 due commands, so the cursor takes what its reserved share allows
    // and finishes on the next run. It never stops advancing.
    const r = await tick(w, state);
    expect(r.payload!.meta.creationCursor).toBe(200);
    const r2 = await tick(w, state);
    expect(r2.payload!.meta.creationCursor).toBe(210);
  });
});

// Review r2: one-way state (resolved bits, the creation cursor) needs the same
// second source as a refund command.
describe('one-way state needs the second source (review r2)', () => {
  it('a fabricated "resolved" at bootstrap sets no bit; the later real resolution is still queued for audit', async () => {
    const w = makeWorld();
    const state = freshState();
    const real = openMarket(1, 'BTC:gt:1', w);
    w.markets = [{ ...real, resolved: true, outcome: 3 }]; // provider B lies
    w.publicMarkets = [real]; // the public RPC tells the truth
    const r1 = await tick(w, state);
    expect(r1.payload!.resolvedBits).toBe('');
    expect(r1.payload!.meta.resolvedBootstrapped).toBe(false);
    expect(r1.payload!.meta.creationCursor).toBe(0);
    expect(r1.failed).toContain('S1');
    expect(r1.healthchecksBody).toContain('providers disagree at the same block');
    // Provider B becomes honest: bootstrap completes without the market.
    w.markets = [real];
    w.publicMarkets = undefined;
    const r2 = await tick(w, state);
    expect(r2.payload!.meta.resolvedBootstrapped).toBe(true);
    expect(r2.payload!.resolvedBits.replace(/0/g, '')).toBe('');
    // The market really resolves: queued exactly once.
    w.markets = [{ ...real, resolved: true, outcome: 1 }];
    const r3 = await tick(w, state);
    expect(r3.payload!.auditAppend.map((a) => a.marketId)).toEqual([0]);
  });

  it('a disagreement that persists for two runs becomes a pb critical naming the markets', async () => {
    const w = makeWorld();
    const state = freshState();
    const real = openMarket(1, 'BTC:gt:1', w);
    w.markets = [{ ...real, yes: 9_000_000n }];
    w.publicMarkets = [real];
    await tick(w, state);
    const r2 = await tick(w, state);
    const pb = r2.payload!.criticals.find((c) => c.key === 'c:pb');
    expect(pb?.line).toMatch(/provider B and the resolver RPC disagree at block \d+ on #0/);
  });

  it('a new resolution is not queued while the second source is down, then queued once', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w)];
    await tick(w, state);
    w.markets[0] = { ...w.markets[0], resolved: true, outcome: 2 };
    w.publicDown = true;
    const r1 = await tick(w, state);
    expect(r1.payload!.auditAppend).toEqual([]);
    expect(r1.failed).toContain('S1');
    w.publicDown = false;
    const r2 = await tick(w, state);
    expect(r2.payload!.auditAppend.map((a) => a.marketId)).toEqual([0]);
    const r3 = await tick(w, state);
    expect(r3.payload!.auditAppend).toEqual([]);
  });

  it('fabricated creation fields cannot move the cursor past a paused-symbol market', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w)];
    await tick(w, state);
    const realNew = openMarket(5, 'KO:gt:60', w);
    w.markets.push({ ...realNew, ref: 'AAPL:gt:200' }); // provider B says a verified symbol
    w.publicMarkets = [w.markets[0], realNew];
    const r1 = await tick(w, state);
    expect(r1.payload!.meta.creationCursor).toBe(1);
    expect(r1.failed).toContain('S1');
    expect(w.telegram.sent.join('\n')).not.toContain('NEW #1');
    w.markets[1] = realNew;
    w.publicMarkets = undefined;
    const r2 = await tick(w, state);
    expect(w.telegram.sent.join('\n')).toContain('NEW #1 STOCKS KO: paused symbol');
    expect(r2.payload!.meta.creationCursor).toBe(2);
  });

  it('bootstrap is one snapshot at one block, even for 450 markets (review r3)', async () => {
    const w = makeWorld();
    const state = freshState();
    const base = closedMarket(1, 'BTC:gt:1', nowS(w), 30 * 86_400, 1_000_000n, 1_000_000n, true);
    w.markets = Array.from({ length: 450 }, () => base);
    w.markets[449] = openMarket(1, 'BTC:gt:1', w);
    const r1 = await tick(w, state);
    expect(r1.payload!.meta).toMatchObject({ resolvedBootstrapped: true, creationCursor: 450 });
    expect(r1.effective).toBe(true);
    expect(r1.httpRequests + r1.doCalls).toBeLessThanOrEqual(32);
    expect(w.telegram.sent.join('\n')).toContain('Resolved before the watchdog, not audited (449): 0-448');
    // 449 resolves after the snapshot block: queued once.
    w.markets[449] = { ...w.markets[449], resolved: true, outcome: 1 };
    const r2 = await tick(w, state);
    expect(r2.payload!.auditAppend.map((a) => a.marketId)).toEqual([449]);
  });

  it('a bootstrap that cannot match every id keeps nothing; the snapshot is taken whole later', async () => {
    const w = makeWorld();
    const state = freshState();
    const resolvedOld = closedMarket(1, 'BTC:gt:1', nowS(w), 30 * 86_400, 1_000_000n, 1_000_000n, true);
    w.markets = [resolvedOld, openMarket(1, 'BTC:gt:1', w), openMarket(1, 'ETH:gt:1', w)];
    w.publicMarkets = [resolvedOld, { ...w.markets[1], yes: 7n }, w.markets[2]]; // one disagreement
    const r1 = await tick(w, state);
    expect(r1.payload!.meta.resolvedBootstrapped).toBe(false);
    expect(r1.payload!.resolvedBits).toBe(''); // nothing partial kept
    expect(r1.failed).toContain('S1');
    expect(r1.healthchecksBody).toContain('bootstrap NOT complete');
    // Market 2 resolves while the bootstrap keeps failing: the snapshot is not
    // taken yet, so it becomes pre-watchdog only because the snapshot is later.
    w.publicMarkets = undefined;
    w.markets[1] = { ...w.markets[1], resolved: true, outcome: 1 }; // resolves before the snapshot
    const r2 = await tick(w, state);
    expect(r2.payload!.meta.resolvedBootstrapped).toBe(true);
    expect(r2.payload!.auditAppend).toEqual([]);
    expect(w.telegram.sent.join('\n')).toContain('not audited (2): 0-1');
    // After the snapshot, a resolution is a transition.
    w.markets[2] = { ...w.markets[2], resolved: true, outcome: 2 };
    const r3 = await tick(w, state);
    expect(r3.payload!.auditAppend.map((a) => a.marketId)).toEqual([2]);
  });

  it('runs are ineffective until the bootstrap snapshot exists', async () => {
    const w = makeWorld({ publicDown: true });
    w.markets = [openMarket(1, 'BTC:gt:1', w)];
    const state = freshState();
    const r1 = await tick(w, state);
    expect(r1.failed).toContain('S1');
    expect(r1.payload!.meta.resolvedBootstrapped).toBe(false);
    w.publicDown = false;
    const r2 = await tick(w, state);
    expect(r2.effective).toBe(true);
  });

  it('200 stable refund commands cannot starve a new resolution or the creation cursor (review r3)', async () => {
    const w = makeWorld();
    const state = freshState();
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 200 }, () => oneSided);
    w.markets.push(openMarket(1, 'BTC:gt:1', w)); // 200: will resolve
    await tick(w, state); // bootstrap; the 200 commands are delivered
    for (let i = 0; i < 3; i++) {
      w.markets[200] = { ...w.markets[200], resolved: i > 0, outcome: i > 0 ? 1 : 0 };
      if (i === 1) w.markets.push(openMarket(5, 'KO:gt:60', w)); // 201: new, paused symbol
      const r = await tick(w, state);
      if (i === 1) {
        // Both one-way items were confirmed in the same run the commands were not due.
        expect(r.payload!.auditAppend.map((a) => a.marketId)).toEqual([200]);
        expect(r.payload!.meta.creationCursor).toBe(202);
        expect(r.effective).toBe(true);
      }
    }
    expect(w.telegram.sent.join('\n')).toContain('NEW #201 STOCKS KO');
  });

  it('at a 6-hour reminder, one-way work goes first and every command follows within a bounded number of runs', async () => {
    const w = makeWorld();
    const state = freshState();
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 200 }, () => oneSided);
    w.markets.push(openMarket(1, 'BTC:gt:1', w));
    const seen = new Set<number>();
    await tick(w, state);
    for (const id of commandIdsIn(w.telegram.sent.join('\n'))) seen.add(id); // the first 50, at bootstrap
    w.clock.t += 6 * 3600_000; // all remaining reminders due
    w.markets[200] = { ...w.markets[200], resolved: true, outcome: 1 };
    const sched = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
    w.telegram.sent = []; // only this run's messages
    const r = await tick(w, state);
    expect(r.payload!.auditAppend.map((a) => a.marketId)).toEqual([200]); // the transition went first
    expect(r.effective).toBe(true); // only command deferral remains, which is allowed
    const deferred = r.payload!.criticals.find((c) => c.key === 'm:199')!;
    // Whether it was re-checked this run or not, its line never claims a
    // command it did not get (review r10), and it is not marked delivered.
    expect(deferred.line).not.toContain('refund command below');
    expect(deferred.line).toMatch(/refund command in a later run|not re-checked this run|NOT CONFIRMED/);
    expect(deferred.lastDeliveredAt).not.toBe(sched); // not marked delivered: still due
    // Every one of the 200 gets its command within a bounded number of runs,
    // longest unserved first (review r4).
    for (const id of commandIdsIn(w.telegram.sent.join('\n'))) seen.add(id);
    let extra = 0;
    for (; extra < 5 && seen.size < 200; extra++) {
      w.telegram.sent = [];
      await tick(w, state);
      for (const id of commandIdsIn(w.telegram.sent.join('\n'))) seen.add(id);
    }
    expect(seen.size).toBe(200);
    expect(extra).toBeLessThanOrEqual(3); // 50 a run after the two already served batches
  });

  it('a deferred command whose alert WAS delivered stays due and gets its command next run', async () => {
    const w = makeWorld();
    const state = freshState();
    const base = closedMarket(1, 'LINK:gt:20', nowS(w), 23 * 3600, 1_000_000n, 0n);
    w.markets = Array.from({ length: 60 }, () => base); // 60 short alert lines: all fit the messages
    await tick(w, state);
    w.clock.t += 6 * 3600_000; // reminders due, commands now allowed
    for (let i = 0; i < 150; i++) w.markets.push(openMarket(1, 'BTC:gt:1', w)); // 150 cursor ids go first
    const r = await tick(w, state);
    // 200, not 210: the 60 stored criticals are re-confirmed too (review r9),
    // so ten cursor ids wait for the next run.
    expect(r.payload!.meta.creationCursor).toBe(200);
    const ids = r.telegramMessages.join('\n').match(/for id in ([\d ]+); do/)![1].trim().split(' ').map(Number);
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => i)); // 0-49 confirmed, 50-59 deferred
    expect(r.telegramMessages.join('\n')).toContain('#59 CRYPTO one-sided'); // the deferred line was sent
    const r2 = await tick(w, state);
    const ids2 = r2.telegramMessages.join('\n').match(/for id in ([\d ]+); do/)![1].trim().split(' ').map(Number);
    expect(ids2).toEqual(Array.from({ length: 10 }, (_, i) => 50 + i));
  });

  it('201 due refund commands: at most 50 a run, all offered within 5 runs, manifest intact', async () => {
    const w = makeWorld();
    const state = freshState();
    const base = closedMarket(1, 'LINK:gt:20', nowS(w), 23 * 3600, 1_000_000n, 0n); // not refundable yet
    w.markets = Array.from({ length: 201 }, () => base);
    await tick(w, state); // bootstrap; criticals delivered without commands
    w.clock.t += 6 * 3600_000; // now past +24h, and the reminders are due
    const seen = new Set<number>();
    let runs = 0;
    while (seen.size < 201 && runs < 8) {
      w.telegram.sent = [];
      const r = await tick(w, state);
      const ids = commandIdsIn(w.telegram.sent.join('\n'));
      expect(ids.length).toBeLessThanOrEqual(50);
      for (const id of ids) seen.add(id);
      if (runs === 0) expect(r.telegramMessages.join('\n').replace(/\n/g, '')).toContain('manifest ids: 0-200');
      runs++;
    }
    expect(seen.size).toBe(201);
    expect(runs).toBeLessThanOrEqual(5);
  });
});

describe('sustained load and budgets (review r4)', () => {
  it('200 new markets before every tick cannot starve refund commands, and the run says it is behind', async () => {
    const w = makeWorld();
    const state = freshState();
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 200 }, () => oneSided);
    w.telegram.sent = [];
    await tick(w, state); // bootstrap: cursor 200, first 50 commands
    const served = new Set<number>(commandIdsIn(w.telegram.sent.join('\n')));
    let cursor = 200;
    for (let run = 0; run < 3; run++) {
      for (let i = 0; i < 200; i++) w.markets.push(openMarket(1, 'BTC:gt:1', w)); // sustained creation
      w.clock.t += 6 * 3600_000; // every old reminder is due again
      w.telegram.sent = [];
      const r = await tick(w, state);
      const ids = commandIdsIn(w.telegram.sent.join('\n'));
      expect(ids.length).toBeGreaterThan(0); // commands keep their share
      for (const id of ids) served.add(id);
      expect(r.payload!.meta.creationCursor).toBeGreaterThan(cursor); // the cursor keeps moving
      cursor = r.payload!.meta.creationCursor;
      expect(r.failed).toContain('S1'); // deferred cursor ids: the run says it is behind
      expect(r.s3Reasons).not.toContain('critical undelivered');
    }
    expect(served.size).toBeGreaterThanOrEqual(150);
  });

  it('a bootstrap that fails leaves no cursor, no bootstrapN and no creation alerts', async () => {
    const w = makeWorld();
    const state = freshState();
    // Both would raise a creation alert, so nothing may be said before the snapshot.
    const a = openMarket(5, 'GS:gt:500', w);
    const b = openMarket(5, 'KO:gt:60', w);
    w.markets = [a, b];
    w.publicMarkets = [a, { ...b, yes: 5n }]; // providers disagree on #1
    const r1 = await tick(w, state);
    expect(r1.payload!.meta).toMatchObject({ creationCursor: 0, bootstrapN: null, resolvedBootstrapped: false, creationPendingSince: null });
    expect(w.telegram.sent.join('\n')).not.toContain('BEFORE WATCHDOG'); // not even for the confirmed #0
    expect(r1.failed).toContain('S1');
    w.publicMarkets = undefined;
    const r2 = await tick(w, state);
    expect(r2.payload!.meta).toMatchObject({ creationCursor: 2, bootstrapN: 2, resolvedBootstrapped: true });
    expect(w.telegram.sent.join('\n')).toContain('BEFORE WATCHDOG #0 STOCKS GS');
    expect(w.telegram.sent.join('\n')).toContain('BEFORE WATCHDOG #1 STOCKS KO');
  });

  it('the bootstrap run stays inside its own ceiling of 32 requests', async () => {
    const w = makeWorld({ clock: { t: Date.UTC(2026, 8, 19, 13, 0, 1) } });
    const base = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 2000 }, () => base);
    const r = await tick(w, freshState());
    expect(r.payload!.meta.resolvedBootstrapped).toBe(true);
    expect(r.httpRequests + r.doCalls).toBeLessThanOrEqual(32);
    expect(w.log.filter((l) => l.startsWith('providerb'))).toHaveLength(11); // 1 discovery + 10 pages
    expect(w.log.filter((l) => l.startsWith('publicrpc'))).toHaveLength(11); // 1 rr probe + 10 snapshot reads
  });

  it('with providers in parallel, a 2,000-market bootstrap at 10 s a request finishes inside the 200 s deadline', async () => {
    const w = makeWorld({ clock: { t: Date.UTC(2026, 8, 19, 13, 0, 1) }, concurrent: true, latencyMs: 10_000 });
    const base = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 2000 }, () => base);
    const t0 = w.clock.t;
    w.finalizedTs = Math.floor(w.clock.t / 1000);
    const r = await runOnce(makeDeps(w, freshState()), Math.floor(t0 / FIVE_MIN) * FIVE_MIN);
    expect(r.kind).toBe('completed');
    expect(r.committed).toBe(true);
    expect(r.payload!.meta.resolvedBootstrapped).toBe(true);
    expect(w.clock.t - t0).toBeLessThan(200_000);
    // Provider B and the public RPC run as separate lanes, about 110 s each.
    expect(w.clock.t - t0).toBeGreaterThan(110_000);
  });
});

describe('command delivery accounting (review r5)', () => {
  /// 50 one-sided markets past +24h: their lines fill message 1, so the
  /// refund command lands in message 2.
  async function fifty(partial?: number) {
    const w = makeWorld({ telegram: { mode: 'ok', retryAfter: 1, sent: [], okMessages: partial } });
    const state = freshState();
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 50 }, () => oneSided);
    return { w, state };
  }

  it('the command is not counted as served when its own message failed', async () => {
    const { w, state } = await fifty(1); // only message 1 is accepted
    const r = await tick(w, state);
    expect(r.telegramMessages.length).toBeGreaterThan(1);
    const commandMessage = r.telegramMessages.findIndex((m) => m.includes('cast send'));
    expect(commandMessage).toBeGreaterThan(0); // it is not in message 1
    // Capped at 50 ids, the command always fits one message, so "every message
    // carrying it" is that one message.
    expect(r.telegramMessages.filter((m) => m.includes('cast send'))).toHaveLength(1);
    expect(r.telegramConfirmed[0]).toBe(true);
    expect(r.telegramConfirmed[commandMessage]).toBe(false);
    expect(r.payload!.criticals.every((c) => c.lastCommandAt === null)).toBe(true);
    expect(r.payload!.criticals.some((c) => c.lastDeliveredAt !== null)).toBe(true); // the accepted lines count
    expect(r.failed).toContain('S3');
    // The very next run offers the commands again, although those alerts were delivered.
    w.telegram.okMessages = undefined;
    w.telegram.sent = [];
    const r2 = await tick(w, state);
    expect(commandIdsIn(w.telegram.sent.join('\n'))).toHaveLength(50);
    expect(r2.payload!.criticals.filter((c) => c.lastCommandAt !== null)).toHaveLength(50);
  });

  it('with every message accepted, the commands are served once and then wait a reminder', async () => {
    const { w, state } = await fifty();
    const r = await tick(w, state);
    expect(commandIdsIn(r.telegramMessages.join('\n'))).toHaveLength(50);
    expect(r.payload!.criticals.filter((c) => c.lastCommandAt !== null)).toHaveLength(50);
    w.telegram.sent = [];
    await tick(w, state);
    expect(commandIdsIn(w.telegram.sent.join('\n'))).toHaveLength(0); // nothing to say
    w.clock.t += 6 * 3600_000;
    w.telegram.sent = [];
    await tick(w, state);
    expect(commandIdsIn(w.telegram.sent.join('\n'))).toHaveLength(50); // reminder
  });

  it('a MAKO command left out of the notices message is not counted, and comes later', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [closedMarket(6, 'house market', nowS(w), 2 * 86_400, 300_000n, 0n)];
    const r1 = await tick(w, state);
    expect(r1.telegramMessages.join('\n')).toContain('cast send');
    const servedFirst = r1.payload!.warnings.find((x) => x.key === 'w:0')!.lastCommandAt;
    expect(servedFirst).not.toBeNull();
    // 80 new paused-symbol markets fill the notices message before the command line.
    w.clock.t += 6 * 3600_000;
    for (let i = 0; i < 80; i++) w.markets.push(openMarket(5, 'KO:gt:60', w));
    w.telegram.sent = [];
    const r2 = await tick(w, state);
    expect(r2.telegramMessages.join('\n')).not.toContain('cast send'); // the command did not fit
    // Not served: the timestamp is still the first run's, so it stays due.
    expect(r2.payload!.warnings.find((x) => x.key === 'w:0')!.lastCommandAt).toBe(servedFirst);
    // Once the backlog of notices drains, the command arrives.
    let served = servedFirst;
    for (let i = 0; i < 4 && served === servedFirst; i++) {
      const r = await tick(w, state);
      served = r.payload!.warnings.find((x) => x.key === 'w:0')!.lastCommandAt;
    }
    expect(served).not.toBe(servedFirst);
  });
});

describe('partial Telegram delivery in any order (review r6)', () => {
  /// 50 one-sided markets past +24h: their lines fill message 1, so the refund
  /// command lands in message 2.
  function fiftyDue(attempts?: ('ok' | 'fail' | '429')[]) {
    const w = makeWorld({ telegram: { mode: 'ok', retryAfter: 1, sent: [], attempts, attemptsMade: 0 } });
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 50 }, () => oneSided);
    return { w, state: freshState() };
  }

  it('the command message is accepted although an earlier message failed: it counts as served', async () => {
    const { w, state } = fiftyDue(['fail', 'ok', 'ok', 'ok']);
    const r = await tick(w, state);
    const commandMessage = r.telegramMessages.findIndex((m) => m.includes('cast send'));
    expect(commandMessage).toBeGreaterThan(0);
    expect(r.telegramConfirmed[0]).toBe(false);
    expect(r.telegramConfirmed[commandMessage]).toBe(true);
    expect(w.telegram.sent.join('\n')).toContain('cast send'); // Joshua has a runnable command
    expect(r.payload!.criticals.filter((c) => c.lastCommandAt !== null)).toHaveLength(50);
    expect(r.failed).toContain('S3'); // a critical message still failed
    expect(r.ping).toBe('fail');
  });

  it('[false, true, false] still records the accepted command message', async () => {
    const { w, state } = fiftyDue(['fail', 'ok', 'fail', 'fail']);
    const r = await tick(w, state);
    const commandMessage = r.telegramMessages.findIndex((m) => m.includes('cast send'));
    expect(r.telegramConfirmed[commandMessage]).toBe(true);
    expect(r.payload!.criticals.filter((c) => c.lastCommandAt !== null)).toHaveLength(50);
  });

  it('every attempt rate-limited past the deadline: nothing is recorded as served', async () => {
    const { w, state } = fiftyDue(['429', '429', '429', '429']);
    w.telegram.retryAfter = 10_000; // far past the run deadline
    const r = await tick(w, state);
    expect(r.telegramConfirmed.every((c) => c === false)).toBe(true);
    expect(r.payload!.criticals.every((c) => c.lastCommandAt === null)).toBe(true);
    expect(r.ping).toBe('fail');
  });

  it('repeated partial delivery with more than 50 commands still drains: the first 50 advance, later ids follow', async () => {
    const w = makeWorld({ telegram: { mode: 'ok', retryAfter: 1, sent: [], attempts: ['fail', 'ok', 'ok', 'ok'], attemptsMade: 0 } });
    const state = freshState();
    const oneSided = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 120 }, () => oneSided);
    const served = new Set<number>();
    let runs = 0;
    while (served.size < 120 && runs < 8) {
      w.telegram.sent = [];
      w.telegram.attemptsMade = 0; // the same pattern every run: message 1 fails
      const r = await tick(w, state);
      for (const id of commandIdsIn(w.telegram.sent.join('\n'))) served.add(id);
      expect(r.payload!.criticals.filter((c) => c.lastCommandAt !== null).length).toBe(served.size);
      runs++;
    }
    expect(served.size).toBe(120);
    expect(runs).toBeLessThanOrEqual(3);
  });
});

describe('budget and category overlap (review r5)', () => {
  it('an ordinary minute-zero run makes 21 HTTP requests: 11 provider B, 1 rr, 1 confirmation, 3 probes, 4 Telegram, 1 Healthchecks', async () => {
    const w = makeWorld({ clock: { t: Date.UTC(2026, 8, 19, 12, 55, 1) } });
    const state = freshState();
    const base = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = Array.from({ length: 2000 }, () => base);
    await tick(w, state); // bootstrap
    w.clock.t = Date.UTC(2026, 8, 19, 14, 0, 1); // minute 0: every probe is due, reminders due
    w.log = [];
    const r = await tick(w, state);
    const count = (h: string) => w.log.filter((l) => l.startsWith(h)).length;
    expect(count('providerb')).toBe(11);
    expect(count('publicrpc')).toBe(2); // rr probe + one confirmation
    expect(count('app.test')).toBe(3);
    expect(count('api.telegram.org')).toBeLessThanOrEqual(4);
    expect(count('hc-ping.test')).toBe(1);
    expect(r.httpRequests).toBeLessThanOrEqual(21);
    expect(r.httpRequests + r.doCalls).toBeLessThanOrEqual(23);
  });

  it('an id that is both a new resolution and a cursor id takes one slot, not two', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [openMarket(1, 'BTC:gt:1', w)];
    await tick(w, state); // bootstrap at N = 1
    // 200 new markets, all created and resolved before the next run: each is
    // both a transition and a cursor id.
    for (let i = 0; i < 200; i++) w.markets.push({ ...openMarket(1, 'BTC:gt:1', w), resolved: true, outcome: 1 });
    w.log = [];
    const r = await tick(w, state);
    expect(w.log.filter((l) => l.startsWith('publicrpc')).length).toBe(2); // rr + ONE confirmation request
    expect(r.payload!.auditAppend).toHaveLength(200); // all 200 confirmed in one run
    expect(r.payload!.meta.creationCursor).toBe(201);
    expect(r.effective).toBe(true);
  });
});

describe('configuration', () => {
  it('rejects provider B and the public RPC on the same origin, and non-HTTPS', async () => {
    const { readEnv } = await import('../src/index');
    const base = {
      WATCHDOG_STATE: undefined as never, MAKO_ADDRESS: MAKO_ADDR, RESOLVER_ADDRESS: RES_ADDR, APP_URL: 'https://makomarket.xyz',
      TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', HEALTHCHECKS_PING_URL: 'https://hc-ping.com/x',
    };
    expect(() => readEnv({ ...base, PUBLIC_RPC_URL: 'https://testnet-rpc.monad.xyz/', PROVIDER_B_URL: 'https://TESTNET-RPC.monad.xyz/v2/key' })).toThrow(/same origin/);
    expect(() => readEnv({ ...base, PUBLIC_RPC_URL: 'https://testnet-rpc.monad.xyz/', PROVIDER_B_URL: 'http://monad-testnet.g.alchemy.com/v2/k' })).toThrow(/HTTPS/);
    expect(readEnv({ ...base, PUBLIC_RPC_URL: 'https://testnet-rpc.monad.xyz/', PROVIDER_B_URL: 'https://monad-testnet.g.alchemy.com/v2/k' }).providerBUrl).toContain('alchemy');
  });
});
