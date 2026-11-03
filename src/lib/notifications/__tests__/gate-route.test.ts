// #214 S1: the RPC gate, the scan client and its error classes (NOTIFICATIONS_PLAN r8 §3.2 "Scanning", r4; §8 S1
// "Gate", "Scan client", "Error classes"), and the cron route's auth, step isolation and time limits (§3.9).
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  v4: null as null | (() => Promise<unknown>),
  rounds: null as null | (() => Promise<unknown>),
}));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<object>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000cc' }));
vi.mock('@/lib/leaderboard/indexer', async (orig) => ({
  ...(await orig<object>()),
  runLeaderboardIndexerOnce: async () => ({ chainId: 10143, contracts: [await state.v4!()] }),
}));
vi.mock('@/lib/notifications/rounds-scan', () => ({ runRoundsScanOnce: async () => state.rounds!() }));

import { makoAbi } from '@/lib/MakoMarkets.abi';
import {
  classifyRpcError,
  createRpcGate,
  createScanClient,
  GateClosed,
  RPC_RETRY_DELAYS_MS,
  withRpcRetry,
} from '@/lib/leaderboard/rpc-gate';
import { GET as notifyTick } from '../../../app/api/cron/notify/route';

import { createNotifyDb } from './harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('RPC gate', () => {
  it('never more than 6 in flight, starts at least 125 ms apart', async () => {
    vi.useFakeTimers();
    const gate = createRpcGate();
    let inFlight = 0;
    let peak = 0;
    const starts: number[] = [];
    const tasks = Array.from({ length: 30 }, () =>
      gate.run(async () => {
        starts.push(Date.now());
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 775));
        inFlight -= 1;
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(tasks);
    expect(peak).toBe(6);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(125);
  });

  it('after refuseAfter every new request is refused at once with GateClosed', async () => {
    let now = 1_000;
    const gate = createRpcGate({ refuseAfter: 2_000, now: () => now });
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
    now = 2_000;
    await expect(gate.run(async () => 'ok')).rejects.toBeInstanceOf(GateClosed);
  });
});

/// A JSON-RPC endpoint stub for global fetch: answers per method, counts requests.
function stubRpc(answer: (method: string, body: { id: number }) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { method: string; id: number };
    calls.push(body.method);
    return answer(body.method, body);
  });
  return calls;
}
const rpcOk = (id: number, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });

describe('scan client', () => {
  it('a 429 and a 503 each make exactly one HTTP request (viem retries off), classed as retry', async () => {
    for (const status of [429, 503]) {
      const calls = stubRpc(() => new Response('busy', { status }));
      const client = createScanClient('https://rpc.example');
      const err = await client.getBlockNumber({ cacheTime: 0 }).catch((e: unknown) => e);
      expect(calls).toHaveLength(1);
      expect(classifyRpcError(err)).toBe('retry');
    }
  });

  it('a JSON-RPC -32011, a timeout and a lost connection are classed as retry; a plain error is not', async () => {
    stubRpc((_m, b) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32011, message: 'requests limited to 25/sec' } }), { status: 200 }));
    expect(classifyRpcError(await createScanClient('https://rpc.example').getBlockNumber({ cacheTime: 0 }).catch((e: unknown) => e))).toBe('retry');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect(classifyRpcError(await createScanClient('https://rpc.example').getBlockNumber({ cacheTime: 0 }).catch((e: unknown) => e))).toBe('retry');
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_u: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const p = createScanClient('https://rpc.example').getBlockNumber({ cacheTime: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(classifyRpcError(await p)).toBe('retry');
    expect(classifyRpcError(new Error('range too wide'))).toBe('other');
    expect(classifyRpcError(new GateClosed())).toBe('gate');
  });

  it('a request queued behind 6 in flight is not timed out by its wait in the queue', async () => {
    vi.useFakeTimers();
    let n = 0;
    stubRpc(async (_m, b) => {
      n += 1;
      // The first six answer after 4.5 s; the seventh at once. Its own 5 s timeout must start after the gate.
      if (n <= 6) await new Promise((r) => setTimeout(r, 4_500));
      return rpcOk(b.id, '0x10');
    });
    const client = createScanClient('https://rpc.example');
    const all = Promise.all(Array.from({ length: 7 }, () => client.getBlockNumber({ cacheTime: 0 })));
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(all).resolves.toHaveLength(7);
  });

  it('a multicall of 140 getMarket calls passes the gate once per eth_call chunk (5)', async () => {
    const calls = stubRpc((_m, b) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32000, message: 'no' } }), { status: 200 }));
    const client = createScanClient('https://rpc.example');
    await client
      .multicall({
        contracts: Array.from({ length: 140 }, (_, i) => ({ address: '0x00000000000000000000000000000000000000aa' as const, abi: makoAbi, functionName: 'getMarket' as const, args: [BigInt(i)] as const })),
        allowFailure: false,
        blockTag: 'finalized',
      })
      .catch(() => undefined);
    expect(calls.filter((m) => m === 'eth_call')).toHaveLength(5);
  });

  it('after refuseAfter the client refuses a new request with GateClosed and sends nothing', async () => {
    const calls = stubRpc((_m, b) => rpcOk(b.id, '0x1'));
    const client = createScanClient('https://rpc.example', Date.now() - 1);
    const err = await client.getBlockNumber({ cacheTime: 0 }).catch((e: unknown) => e);
    expect(classifyRpcError(err)).toBe('gate');
    expect(calls).toHaveLength(0);
  });

  it('withRpcRetry: retried twice (1 s, 2 s) on the same call; a third failure is final; others are not retried', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    let tries = 0;
    await expect(
      withRpcRetry(async () => {
        tries += 1;
        throw Object.assign(new Error('limited'), { code: -32011 });
      }, sleep),
    ).rejects.toThrow('limited');
    expect(tries).toBe(3);
    expect(waits).toEqual([...RPC_RETRY_DELAYS_MS]);
    tries = 0;
    await expect(
      withRpcRetry(async () => {
        tries += 1;
        throw new Error('plain');
      }, sleep),
    ).rejects.toThrow('plain');
    expect(tries).toBe(1);
  });
});

describe('GET /api/cron/notify', () => {
  const SECRET = 'test-cron-secret-0123456789';
  const scan = { contractAddress: '0x00000000000000000000000000000000000000aa', mutex: 'acquired', fromBlock: 1, scannedTo: 9, scanTarget: 9, eventsInserted: 0, upToDate: true, budgetExhausted: false, notifiedThrough: 9, noFloor: false, rosterFromChain: 0 };
  const call = (auth?: string) => notifyTick(new Request('http://x/api/cron/notify', { headers: auth ? { authorization: auth } : {} }));

  it('refuses a missing or wrong Bearer with 403', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect((await call()).status).toBe(403);
    expect((await call('Bearer nope-nope-nope-nope-nope')).status).toBe(403);
  });

  it('isolates steps: a failed V4 step does not stop Rounds or the prune; no contract address in the answer', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const t = await createNotifyDb();
    state.db = t.db;
    state.v4 = async () => {
      throw new Error('rpc down');
    };
    state.rounds = async () => scan;
    const body = (await (await call(`Bearer ${SECRET}`)).json()) as Record<string, unknown>;
    expect(body.v4).toEqual({ error: 'step_failed' });
    expect(body.rounds).toMatchObject({ upToDate: true, notifiedThrough: 9 });
    expect(body.rounds).not.toHaveProperty('contractAddress');
    expect(body.prune).toEqual({ notifications: 0, reminders: 0, entrants: 0 });
    await t.close();
  });

  it('prune boundaries: 90 days for notifications, 7 days after the event for reminders, 9 days for entrants', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const t = await createNotifyDb();
    state.db = t.db;
    state.v4 = async () => scan;
    state.rounds = async () => scan;
    const u = (await t.client.query<{ id: string }>(`INSERT INTO users (wallet_address, auth_type) VALUES ('0x00000000000000000000000000000000000000d1', 'wallet') RETURNING id`)).rows[0].id;
    const add = (key: string, kind: string, created: string, event: string) =>
      t.client.query(`INSERT INTO notifications (user_id, kind, dedupe_key, data, created_at, event_at) VALUES ($1, $2, $3, '{}', now() - $4::interval, now() - $5::interval)`, [u, kind, key, created, event]);
    await add('old', 'claim', '91 days', '91 days');
    await add('keep', 'claim', '89 days', '89 days');
    await add('close-old', 'closing', '1 day', '8 days');
    await add('close-keep', 'round_start', '1 day', '6 days');
    for (const [acct, age] of [['0x00000000000000000000000000000000000000e1', '10 days'], ['0x00000000000000000000000000000000000000e2', '8 days']]) {
      await t.client.query(`INSERT INTO mako_round_entrants (contract_address, round_id, account, side, block_number, created_at) VALUES ($1, '1', $2, 1, 1, now() - $3::interval)`, ['0x00000000000000000000000000000000000000cc', acct, age]);
    }
    const body = (await (await call(`Bearer ${SECRET}`)).json()) as Record<string, unknown>;
    expect(body.prune).toEqual({ notifications: 1, reminders: 1, entrants: 1 });
    expect((await t.client.query<{ dedupe_key: string }>(`SELECT dedupe_key FROM notifications ORDER BY 1`)).rows.map((r) => r.dedupe_key)).toEqual(['close-keep', 'keep']);
    await t.close();
  });

  it('a step that would begin after 48 s is skipped and reported as skipped: time', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    state.v4 = async () => {
      vi.setSystemTime(new Date('2026-10-22T12:00:49Z'));
      return scan;
    };
    state.rounds = async () => {
      throw new Error('must not run');
    };
    const body = (await (await call(`Bearer ${SECRET}`)).json()) as Record<string, unknown>;
    expect(body.v4).toMatchObject({ upToDate: true });
    expect(body.rounds).toEqual({ skipped: 'time' });
    expect(body.prune).toEqual({ skipped: 'time' });
  });
});
