// Shared test plumbing: a market Durable Object (the real one, from wrangler.toml), a fake chain, and injected
// dependencies. Storage persists inside a test file, so each test wipes the object first.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { migrate } from '../src/book';
import type { Env } from '../src/env';
import { handleAlarm, handleRequest, type MarketDeps } from '../src/market';
import { CHAIN_ID, EXCHANGE, makeFetch, World } from './fake';
import { body, type VecOrder } from './vectors';

export interface Harness {
  id: string;
  w: World;
  deps: MarketDeps;
  logs: string[];
  settled: unknown[];
  refused: Set<string>;
  settleAccepts: boolean;
  settlerDown: boolean;
  /// What the settler reports it holds (hashes).
  held: string[];
  stub: ReturnType<typeof env.MARKET.get>;
  /// The object's state while a request runs (a nested runInDurableObject would not see the same view).
  state: DurableObjectState | null;
  /// Calls the market object's request handler with the fake chain.
  call(method: string, path: string, init?: { body?: unknown; marketHeader?: string | null; env?: Partial<Env> }): Promise<Response>;
  place(o: VecOrder): Promise<{ status: number; json: Record<string, unknown> }>;
  placeRaw(o: { order: VecOrder['order']; signature: Hex }): Promise<{ status: number; json: Record<string, unknown> }>;
  tick(envOverride?: Partial<Env>): Promise<void>;
  sql<T = Record<string, unknown>>(q: string, ...a: unknown[]): Promise<T[]>;
  alerts(): Promise<{ code: string; detail: string }[]>;
}

export async function fresh(id = '1'): Promise<Harness> {
  const stub = env.MARKET.get(env.MARKET.idFromName(id));
  await runInDurableObject(stub, async (_i, state) => {
    await state.storage.deleteAlarm();
    state.storage.sql.exec('DROP TABLE IF EXISTS orders');
    state.storage.sql.exec('DROP TABLE IF EXISTS meta');
    state.storage.sql.exec('DROP TABLE IF EXISTS alerts');
    migrate(state.storage.sql);
  });
  const w = new World();
  const logs: string[] = [];
  const h: Harness = {
    id,
    w,
    logs,
    settled: [],
    refused: new Set(),
    settleAccepts: false,
    settlerDown: false,
    held: [],
    stub,
    state: null,
    deps: null as unknown as MarketDeps,
    async call(method, path, init = {}) {
      const headers = new Headers();
      const hdr = init.marketHeader === undefined ? id : init.marketHeader;
      if (hdr !== null) headers.set('x-market-id', hdr);
      const e = { ...env, ...(init.env ?? {}) } as Env;
      const text = init.body === undefined ? undefined : JSON.stringify(init.body);
      // The Request is built inside the object: a body made outside it belongs to another I/O context.
      const out = await runInDurableObject(stub, async (_i, state) => {
        const req = new Request(`https://market${path}`, { method, headers, body: text });
        h.state = state;
        const res = await handleRequest(state, e, req, h.deps);
        return { status: res.status, text: await res.text() };
      });
      return new Response(out.text, { status: out.status });
    },
    async place(o) {
      const res = await h.call('POST', '/orders', { body: body(o.order, o.signature) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    async placeRaw(o) {
      const res = await h.call('POST', '/orders', { body: body(o.order, o.signature) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    async tick(envOverride) {
      const e = { ...env, ...(envOverride ?? {}) } as Env;
      await runInDurableObject(stub, async (_i, state) => {
        // The runtime clears the alarm that is firing before it calls alarm().
        await state.storage.deleteAlarm();
        await handleAlarm(state, e, h.deps);
      });
    },
    async sql(q, ...a) {
      return runInDurableObject(stub, (_i, state) => state.storage.sql.exec(q, ...a).toArray()) as never;
    },
    async alerts() {
      return h.sql<{ code: string; detail: string }>('SELECT code, detail FROM alerts ORDER BY id');
    },
  };
  h.deps = {
    fetch: makeFetch(w),
    now: () => w.nowMs,
    log: (l) => logs.push(l),
    async refusedToday(m) {
      if (h.settlerDown) throw new Error('down');
      return h.refused.has(m.toLowerCase());
    },
    async settle(b) {
      h.settled.push(b);
      return { accepted: h.settleAccepts };
    },
    async held() {
      if (h.settlerDown) throw new Error('down');
      return new Set(h.held);
    },
  };
  void CHAIN_ID;
  void EXCHANGE;
  return h;
}

/// Gives a wallet the cash (a buy) or the shares (a sell) the order needs.
export function fund(w: World, o: VecOrder['order'], extra = 0n) {
  if (o.isBuy) w.setCash(o.maker, (o.size * BigInt(o.price)) / 100n + extra + 10n ** 6n);
  else w.setPosition(o.marketId, o.option, o.maker, o.size + extra);
}
