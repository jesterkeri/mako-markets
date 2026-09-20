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
  return { acquire: (a, b) => s.acquire(a, b), commit: (t, a, p) => s.commit(t, a, p) };
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
    expect(() => decodeMarketHead(1, encodeMarket({ mType: 1, ref: 'BTC:gt:1', createdAt: 1, closeTime: FAR, bettingCloseTime: FAR, yes: 0n, no: 0n, resolved: false }))).toThrow(/plausible timestamp/);
    // The year 2100 bound, either side.
    const ok = { mType: 1, ref: 'BTC:gt:1', createdAt: 1, closeTime: 4_102_444_800, bettingCloseTime: 4_102_444_800, yes: 0n, no: 0n, resolved: false };
    expect(decodeMarketHead(1, encodeMarket(ok)).closeTime).toBe(4_102_444_800);
    expect(() => decodeMarketHead(1, encodeMarket({ ...ok, closeTime: 4_102_444_801 }))).toThrow();
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
    expect(w.hc.pings[0].body).toContain('nothing was committed');
    for (const text of [w.hc.pings[0].body, logs.join('\n')]) {
      expect(text).not.toContain('SECRET-KEY');
      expect(text).not.toContain('providerb.test');
    }
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
