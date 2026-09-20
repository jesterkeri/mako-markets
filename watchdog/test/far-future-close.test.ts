// A market head whose times are far in the future used to stop the watchdog
// dead: the head decoder accepted any time word below 2^53, and fmtUtc's
// `new Date(unixS * 1000).toISOString()` throws RangeError beyond the range
// ECMAScript Date covers (about 8.64e12 seconds). The throw escaped runOnce,
// so the run committed nothing, alerted nobody and pinged Healthchecks not at
// all, on that run and every run after it. Found by the adversary subagent,
// 2026-09-20.
//
// Provenance: this is a provider answer, not V4 state. The deployed contract
// caps a market at MAX_DURATION = 7 days (d088ced L352-354) and writes
// closeTime and bettingCloseTime only in createMarket (L389-390). Provider B
// is untrusted by design, which is the whole point of the fail-closed
// discovery gate and the second-source confirmation.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { creationFindings, fmtUtc, unsupportedOracle } from '../src/classify';
import { decodeMarketHead } from '../src/abi';
import { runGuarded, runOnce, type Deps } from '../src/run';
import { closedMarket, encodeMarket, makeDeps, makeWorld, type FakeMarket, type World } from './fake';

let n = 0;
function freshState(): Deps['state'] {
  const s = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName(`far-future-${n++}`));
  return { acquire: (a) => s.acquire(a), commit: (t, a, p) => s.commit(t, a, p) };
}

const FIVE_MIN = 300_000;
async function tick(w: World, state: Deps['state']) {
  const scheduled = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
  w.pageRequestIndex = 0;
  w.latestBlock += 600;
  w.finalizedBlock += 600;
  w.finalizedTs = Math.floor(w.clock.t / 1000);
  const r = await runOnce(makeDeps(w, state), scheduled);
  w.clock.t = scheduled + FIVE_MIN + 1_000;
  return r;
}

/// Inside 2^53, past the range Date can format.
const FAR = 9_000_000_000_000;
const nowS = (w: World) => Math.floor(w.clock.t / 1000);

function farFuture(w: World, mType: number, ref: string): FakeMarket {
  return { mType, ref, createdAt: nowS(w) - 600, closeTime: FAR, bettingCloseTime: FAR, yes: 1_000_000n, no: 0n, resolved: false };
}

describe('a time no V4 market can have', () => {
  it('is rejected by the decoder, so the id is unread like any other bad answer', () => {
    const far = { mType: 1, ref: 'BTC:gt:1', createdAt: FAR - 86_400, closeTime: FAR, bettingCloseTime: FAR, yes: 0n, no: 0n, resolved: false };
    expect(() => decodeMarketHead(1, encodeMarket(far), 1_800_000_000)).toThrow(/created after the block/);
  });

  it('a valid market that spans the year 2100 is accepted (review r7: no calendar cap)', () => {
    // Created 2099-12-31T23:58:00Z, closing five minutes later, in 2100.
    const createdAt = Date.UTC(2099, 11, 31, 23, 58) / 1000;
    const m = { mType: 1, ref: 'BTC:gt:1', createdAt, closeTime: createdAt + 300, bettingCloseTime: createdAt + 200, yes: 0n, no: 0n, resolved: false };
    const head = decodeMarketHead(1, encodeMarket(m), createdAt + 10);
    expect(head.closeTime).toBe(createdAt + 300);
    expect(fmtUtc(head.closeTime)).toContain('2100-01-01');
  });

  it("rejects heads that break V4's own timing rules", () => {
    const base = { mType: 1, ref: 'BTC:gt:1', createdAt: 1_800_000_000, closeTime: 1_800_000_000 + 86_400, bettingCloseTime: 1_800_000_000 + 43_200, yes: 0n, no: 0n, resolved: false };
    const head = 1_800_000_100;
    expect(decodeMarketHead(1, encodeMarket(base), head).closeTime).toBe(base.closeTime);
    for (const [label, bad] of [
      ['duration under 5 minutes', { ...base, closeTime: base.createdAt + 299, bettingCloseTime: base.createdAt + 100 }],
      ['duration over 7 days', { ...base, closeTime: base.createdAt + 604_801 }],
      ['betting close after close', { ...base, bettingCloseTime: base.closeTime + 1 }],
      ['betting close at creation', { ...base, bettingCloseTime: base.createdAt }],
      // Review r8: both read paths request an explicit block, and V4 writes
      // createdAt as that block's timestamp, so ONE second past the head is
      // already impossible. There is no slack.
      ['created one second after the head block', { ...base, createdAt: head + 1, closeTime: head + 301, bettingCloseTime: head + 2 }],
      ['created five minutes after the head block', { ...base, createdAt: head + 301, closeTime: head + 301 + 86_400, bettingCloseTime: head + 301 + 43_200 }],
    ] as const) {
      expect(() => decodeMarketHead(1, encodeMarket(bad), head), label).toThrow();
    }
    // Created IN the head block is the boundary and is valid.
    const atHead = { ...base, createdAt: head, closeTime: head + 86_400, bettingCloseTime: head + 43_200 };
    expect(decodeMarketHead(1, encodeMarket(atHead), head).createdAt).toBe(head);
    // A market that does not exist still decodes as zeros.
    expect(decodeMarketHead(9, encodeMarket(null), head).closeTime).toBe(0);
  });

  it('never makes a formatting or classification path throw', () => {
    for (const t of [FAR, Number.MAX_SAFE_INTEGER, 8_640_000_000_001, -1, 0]) {
      expect(() => fmtUtc(t)).not.toThrow();
      const m = { id: 1, mType: 1, oracleRef: '0x' + '00'.repeat(32), createdAt: 0, closeTime: t, bettingCloseTime: t, totalYes: 1n, totalNo: 0n, resolved: false };
      expect(() => unsupportedOracle(m, 1_800_000_000)).not.toThrow();
      expect(() => creationFindings(m, false)).not.toThrow();
    }
    expect(fmtUtc(FAR)).toBe(`unix ${FAR}`);
  });

  it('a poisoned head leaves the run alive: it commits, pings, and still queues a real resolution', async () => {
    const w = makeWorld();
    const state = freshState();
    w.markets = [closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 3600, 1_000_000n, 0n)];
    const first = await tick(w, state); // bootstrap
    expect(first.effective).toBe(true);

    // Provider B starts returning a market no contract could produce, and a
    // real market resolves in the same run.
    w.markets.push(farFuture(w, 1, 'PEPE:gt:1')); // id 1: also an unsupported ref
    w.markets[0] = { ...w.markets[0], resolved: true, outcome: 3 };
    const r = await tick(w, state);
    expect(r.kind).toBe('completed');
    expect(r.committed).toBe(true); // progress is never thrown away (plan §5.3)
    expect(r.ping).not.toBeNull(); // exactly one Healthchecks request (§5.5)
    expect(r.failed).toContain('S1'); // the poisoned id counts as unread
    expect(r.payload!.auditAppend.map((a) => a.marketId)).toEqual([0]); // I8a holds
    expect(r.payload!.meta.creationCursor).toBe(1); // the cursor stops at the unread id
  });
});

// Review r8: both read paths ask for an explicit block, and V4 writes
// createdAt as that block's own timestamp, so a head claiming creation even
// one second later cannot be that block's state. A provider that cannot
// honour a block tag is the failure being detected: the id must go unread,
// not widen what counts as chain state.
describe('a head created after the block it was read at', () => {
  const aheadOf = (ts: number): FakeMarket => ({
    mType: 1, ref: 'BTC:gt:1', createdAt: ts + 1, closeTime: ts + 301, bettingCloseTime: ts + 2, yes: 0n, no: 0n, resolved: false,
  });

  it('is unread on the provider B page read, so the cursor does not pass it', async () => {
    const w = makeWorld();
    const ts = Math.floor(w.clock.t / 1000);
    w.markets = [aheadOf(ts)];
    const r = await tick(w, freshState());
    expect(r.payload!.meta.creationCursor).toBe(0);
    expect(r.payload!.meta.resolvedBootstrapped).toBe(false); // an id was not read
    expect(r.failed).toContain('S1');
  });

  it('is unread on the public confirmation read, so nothing is confirmed from it', async () => {
    const w = makeWorld();
    const ts = Math.floor(w.clock.t / 1000);
    const real = closedMarket(1, 'BTC:gt:1', ts, 600, 0n, 0n);
    w.markets = [real]; // provider B is honest
    w.publicMarkets = [aheadOf(ts)]; // the second source answers the impossible head
    const r = await tick(w, freshState());
    expect(r.payload!.meta.resolvedBootstrapped).toBe(false);
    expect(r.failed).toContain('S1');
    // Unread, not "disagreed": the decoder refused the head rather than
    // comparing it, so this is a public-RPC read failure, not two sources
    // reporting different chain state.
    expect(r.healthchecksBody).toContain('public RPC could not read every market');
    expect(r.healthchecksBody).not.toContain('providers disagree');
  });
});

describe('an unexpected throw still reaches Joshua', () => {
  it('pings Healthchecks /fail with the error type only, never its message', async () => {
    const w = makeWorld();
    const secretish = new Error('https://providerb.test/v2/SECRET-KEY failed');
    secretish.name = 'TypeError';
    const logs: string[] = [];
    const out = await runGuarded(makeDeps(w, freshState(), logs), Date.UTC(2026, 8, 20, 12, 0), async () => {
      throw secretish;
    });
    expect(out).toMatchObject({ kind: 'crashed', error: 'TypeError', pingAccepted: true });
    expect(w.hc.pings).toHaveLength(1);
    expect(w.hc.pings[0].url).toMatch(/\/fail$/);
    expect(w.hc.pings[0].body).toContain('the run threw TypeError');
    expect(w.hc.pings[0].body).toContain('treat this run as incomplete');
    for (const text of [w.hc.pings[0].body, logs.join('\n')]) {
      expect(text).not.toContain('SECRET-KEY');
      expect(text).not.toContain('providerb.test');
    }
  });

  // Review r7: the guard is the last boundary before silence, so nothing it
  // does itself may throw. Each of these would have escaped it before.
  it('survives a hostile thrown value and an out-of-range scheduled time', async () => {
    const hostile = { get name() { throw new Error('getter'); } };
    const w1 = makeWorld();
    const out1 = await runGuarded(makeDeps(w1, freshState()), Date.UTC(2026, 8, 20, 12, 0), async () => {
      throw hostile;
    });
    expect(out1).toMatchObject({ kind: 'crashed', error: 'Error' });
    expect(w1.hc.pings).toHaveLength(1);

    const w2 = makeWorld();
    const out2 = await runGuarded(makeDeps(w2, freshState()), Number.MAX_SAFE_INTEGER, async () => {
      const e = new Error('x');
      e.name = 'Ru\u0000nt\nimeError'.padEnd(200, '!');
      throw e;
    });
    // Bounded to 64 characters BEFORE the non-printable characters are
    // stripped (review r8), so two of them leave 62.
    expect(out2).toMatchObject({ kind: 'crashed', error: 'RuntimeError' + '!'.repeat(50) });
    expect(w2.hc.pings[0].body).toContain(`ms ${Number.MAX_SAFE_INTEGER}`);
  });

  it('a run that does not throw is returned untouched', async () => {
    const w = makeWorld();
    w.markets = [closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 3600, 1_000_000n, 0n)];
    const scheduled = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
    w.finalizedTs = Math.floor(w.clock.t / 1000);
    const out = await runGuarded(makeDeps(w, freshState()), scheduled);
    expect(out).toMatchObject({ kind: 'completed', committed: true });
  });
});
