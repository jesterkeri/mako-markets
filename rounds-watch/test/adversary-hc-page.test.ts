// Adversary pass on 9acab54..5ac8a70: the Healthchecks page cursor (spec B) and the Multicall3 reads (spec D).
//
// Spec B: the cursor may move past a page ONLY after Healthchecks accepted that page; repeating a page is
// acceptable, skipping one is a defect, including across overlapping runs. Spec D: a failed or malformed read
// is never "no alert". Every fixture is built with the repo's own encoders (viem + the WATCH_ABI); the alert
// state is seeded through the same Meta shape the Durable Object stores.

import { env } from 'cloudflare:workers';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { REFUND_REASON, STATUS, WATCH_ABI } from '../src/abi';
import { AGGREGATE3_ABI, MULTICALL3 } from '../src/multicall';
import { makeNet } from '../src/net';
import { runWatch, UNSETTLED_ALERT_S, type WatchConfig, type WatchDeps } from '../src/run';
import { INITIAL_META, type Meta } from '../src/state';

const RPC = 'https://rpc.test';
const DS = 'https://ds.test';
const cfg: WatchConfig = {
  roundsAddress: '0x00000000000000000000000000000000000A11CE',
  rpcUrl: RPC,
  datastreamsUrl: DS,
  datastreamsKey: 'APIKEY-never-print',
  datastreamsSecret: 'S3CRET-never-print',
};
const C = 1_789_530_060;

interface R {
  start: number;
  status: number;
  reason?: number;
  up: bigint;
  down: bigint;
}

let w: {
  now: number;
  rounds: R[];
  telegramOk: boolean;
  messages: string[];
  pings: { kind: string; body: string; accepted: boolean }[];
  meta: Meta;
  /// Rewrites the aggregate3 answer, to model a partial or malformed Multicall3 result.
  mangle: ((results: { success: boolean; returnData: Hex }[]) => { success: boolean; returnData: Hex }[]) | null;
};

function roundResult(r: R) {
  return {
    creator: '0x0000000000000000000000000000000000000C0C' as Hex,
    openTime: BigInt(r.start - 3600),
    startTime: BigInt(r.start),
    status: r.status,
    outcome: 0,
    refundReason: r.reason ?? 0,
    anchorPrice: 0n,
    closePrice: 0n,
    anchorObservedAt: 0,
    closeObservedAt: 0,
    anchorReportHash: ('0x' + '0'.repeat(64)) as Hex,
    closeReportHash: ('0x' + '0'.repeat(64)) as Hex,
    upPool: r.up,
    downPool: r.down,
    upEntrants: 1,
    downEntrants: 1,
    protocolFee: 0n,
    creatorFee: 0n,
    distributable: 0n,
    winnersClaimed: 0,
    paidOut: 0n,
  };
}

function answerRead(data: Hex): Hex {
  const { functionName, args } = decodeFunctionData({ abi: WATCH_ABI, data });
  if (functionName === 'roundCount') return encodeAbiParameters([{ type: 'uint256' }], [BigInt(w.rounds.length)]);
  if (functionName === 'DURATION') return encodeAbiParameters([{ type: 'uint64' }], [900n]);
  return encodeFunctionResult({ abi: WATCH_ABI, functionName: 'roundOf', result: roundResult(w.rounds[Number(args![0]) - 1]) });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith(RPC)) {
    const calls = JSON.parse(String(init?.body)) as { id: number; params: [{ to: Hex; data: Hex }] }[];
    return Response.json(
      calls.map((c) => {
        if (c.params[0].to.toLowerCase() === MULTICALL3.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: AGGREGATE3_ABI, data: c.params[0].data });
          let results = (args![0] as readonly { callData: Hex }[]).map((x) => ({ success: true, returnData: answerRead(x.callData) }));
          if (w.mangle) results = w.mangle(results);
          return { jsonrpc: '2.0', id: c.id, result: encodeFunctionResult({ abi: AGGREGATE3_ABI, functionName: 'aggregate3', result: results }) };
        }
        return { jsonrpc: '2.0', id: c.id, result: answerRead(c.params[0].data) };
      }),
    );
  }
  // Data Streams is never asked in these tests: every due round is seeded with a fresh check.
  throw new Error('unexpected url');
}) as typeof fetch;

function deps(accept: () => boolean = () => true): WatchDeps {
  return {
    net: makeNet(fakeFetch, () => w.now, async () => {}, w.now + 120_000, 14),
    state: {
      acquire: async () => ({ ok: true as const, token: 1, meta: structuredClone(w.meta) }),
      commit: async (_t, m) => {
        w.meta = structuredClone(m);
        return { ok: true };
      },
      advanceHcCursor: async (from, next) => {
        if (w.meta.hcCursor !== from) return { ok: false };
        w.meta.hcCursor = next;
        return { ok: true };
      },
    },
    hmac: async () => 'ab'.repeat(32),
    telegram: async (text) => {
      w.messages.push(text);
      return w.telegramOk;
    },
    ping: async (kind, body) => {
      const accepted = accept();
      w.pings.push({ kind, body, accepted });
      return accepted;
    },
  };
}

const noPriceRound = (): R => ({ start: C - 900, status: STATUS.Refunded, reason: REFUND_REASON.NoPrice, up: 1n, down: 1n });
const activeRound = (): R => ({ start: C - 900, status: STATUS.Active, up: 1n, down: 1n });
const ids = (body: string) => [...body.matchAll(/Round (\d+) (?:REFUNDED|is UNSETTLED)/g)].map((m) => Number(m[1]));

/// Seeds `count` NoPrice alerts waiting for Telegram (ids from..from+count-1), each with a fresh report
/// check, exactly as the watch leaves them after a Telegram outage. More lines than one page carries.
function seedNoPrice(from: number, count: number) {
  for (let id = from; id < from + count; id++) {
    w.meta.noPrice[String(id)] = { startTime: C - 900, closeTime: C };
    w.meta.evidence[String(id)] = { start: 'exists', close: 'exists', at: w.now };
  }
}

beforeEach(() => {
  w = { now: (C + 86_400) * 1000, rounds: [], telegramOk: false, messages: [], pings: [], meta: structuredClone(INITIAL_META), mangle: null };
});

describe('B: the page cursor moves only past a page Healthchecks accepted', () => {
  it('a run where Telegram confirmed some lines does not move the cursor past a page it never sent', async () => {
    const N = 2000;
    w.rounds = Array.from({ length: N }, noPriceRound);
    w.meta.historyCursor = N + 1;
    seedNoPrice(1, N);

    // Run 1: Telegram is up, but one message carries only the first few dozen lines.
    w.telegramOk = true;
    const o1 = await runWatch(cfg, deps());
    const told = new Set(ids(w.messages.join('\n')));
    expect(told.size).toBeGreaterThan(0);
    expect(told.size).toBeLessThan(N);
    const ping1 = w.pings.at(-1)!;
    expect(ping1).toMatchObject({ kind: 'fail', accepted: true });
    // Whatever page the cursor moved past must have been in the accepted body.
    const unsent = (o1.hcPage ?? []).filter((l) => !ping1.body.includes(l)).length;
    if (w.meta.hcCursor !== 0) expect(unsent, `cursor moved 0 -> ${w.meta.hcCursor} past page lines absent from the accepted body`).toBe(0);
  });

  it('the first line delivered nowhere is in the next Healthchecks page once Telegram fails', async () => {
    const N = 2000;
    w.rounds = Array.from({ length: N }, noPriceRound);
    w.meta.historyCursor = N + 1;
    seedNoPrice(1, N);

    w.telegramOk = true;
    await runWatch(cfg, deps()); // Telegram takes the first lines; the Healthchecks body has no page
    const told = new Set(ids(w.messages.join('\n')));
    const firstUntold = Array.from({ length: N }, (_, i) => i + 1).find((id) => !told.has(id))!;

    w.telegramOk = false; // Telegram goes down for good
    w.now += 300_000;
    await runWatch(cfg, deps());
    expect(w.pings.at(-1)!.body).toContain('TELEGRAM DELIVERY FAILED');
    expect(ids(w.pings.at(-1)!.body)).toContain(firstUntold);
  });

  it('a line that leaves the set ahead of the cursor does not make the next page skip a line', async () => {
    // Round 1 is unsettled (its line sorts first), rounds 2..N+1 are NoPrice. Telegram is down throughout.
    const N = 2000;
    w.rounds = [activeRound(), ...Array.from({ length: N }, noPriceRound)];
    w.meta.historyCursor = N + 2;
    w.meta.active = [1];
    w.now = (C + UNSETTLED_ALERT_S + 600) * 1000;
    w.meta.evidence['1'] = { start: 'exists', close: 'exists', at: w.now };
    seedNoPrice(2, N);

    await runWatch(cfg, deps()); // page A, accepted
    const a = ids(w.pings.at(-1)!.body);
    expect(a[0]).toBe(1);

    w.rounds[0] = { ...w.rounds[0], status: STATUS.Settled }; // the keeper finally settles round 1
    w.now += 300_000;
    await runWatch(cfg, deps()); // page B
    const b = ids(w.pings.at(-1)!.body);
    // Whole lines, in round order: page B must begin at the round right after page A's last one.
    expect(b[0]).toBe(a.at(-1)! + 1);
  });
});

describe('B: overlapping runs on the real Durable Object', () => {
  it('a stale commit after another run advanced the cursor only repeats a page', async () => {
    const N = 2000;
    w.rounds = Array.from({ length: N }, noPriceRound);
    const stub = env.WATCH_STATE.get(env.WATCH_STATE.idFromName('adversary-overlap'));
    const seed = await stub.acquire(0);
    if (!seed.ok) throw new Error('no lease');
    w.meta.historyCursor = N + 1;
    seedNoPrice(1, N);
    expect(await stub.commit(seed.token, w.meta, 1)).toEqual({ ok: true });

    const real = (hook?: () => Promise<void>): WatchDeps => ({
      ...deps(),
      state: {
        acquire: (now) => stub.acquire(now),
        commit: (t, m, now) => stub.commit(t, m, now),
        advanceHcCursor: async (from, next) => {
          if (hook) await hook();
          return stub.advanceHcCursor(from, next);
        },
      },
    });
    // A commits and pings; before A moves the cursor, B acquires (same cursor) and later commits it back.
    let bDone: Promise<unknown> = Promise.resolve();
    await runWatch(cfg, real(async () => {
      bDone = runWatch(cfg, real());
    }));
    await bDone;
    const pages = w.pings.map((p) => ids(p.body));
    // B either repeats A's page or continues after it; never starts beyond A's last line + 1.
    expect([pages[0][0], pages[0].at(-1)! + 1]).toContain(pages[1][0]);
    const c = await stub.acquire(10_000_000);
    if (!c.ok) throw new Error('no lease');
    // The cursor is a round id since the fix: unmoved, or the round after A's page, or after B's page.
    expect([0, pages[0].at(-1)! + 1, pages[1].at(-1)! + 1]).toContain(c.meta.hcCursor);
  }, 60_000);
});

describe('D: a partial or malformed Multicall3 answer is never "no alert"', () => {
  const setup = () => {
    w.rounds = [activeRound(), activeRound()];
    w.now = (C + UNSETTLED_ALERT_S) * 1000;
    w.telegramOk = true;
  };
  it('success false for one call', async () => {
    setup();
    w.mangle = (r) => r.map((x, i) => (i === 1 ? { success: false, returnData: '0x' as Hex } : x));
    expect((await runWatch(cfg, deps())).status).toBe('rpc-error');
    expect(w.meta.historyCursor).toBe(1);
  });
  it('one result too few', async () => {
    setup();
    w.mangle = (r) => r.slice(0, 1);
    expect((await runWatch(cfg, deps())).status).toBe('rpc-error');
  });
  it('one result too many', async () => {
    setup();
    w.mangle = (r) => [...r, r[0]];
    expect((await runWatch(cfg, deps())).status).toBe('rpc-error');
  });
  it('success true with empty return data (a target with no code)', async () => {
    setup();
    w.mangle = (r) => r.map(() => ({ success: true, returnData: '0x' as Hex }));
    expect((await runWatch(cfg, deps())).status).toBe('rpc-error');
    expect(w.meta.historyCursor).toBe(1);
    expect(w.pings).toEqual([]);
  });
});
