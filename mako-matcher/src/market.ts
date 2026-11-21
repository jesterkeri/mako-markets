// MatcherMarket: one Durable Object per market (plan 6.1). It is single-threaded, so intake and matching are
// serial; the book lives in its SQLite storage. It is reached only through env.MARKET.idFromName(<canonical id>).
import { DurableObject } from 'cloudflare:workers';
import type { Hex } from 'viem';
import { makeAlert, type Alert } from './alerts';
import { allOrders, deleteBelowNonce, deleteByHash, deleteExpired, delMeta, getMeta, markInFlight, migrate, releaseInFlight, setMeta, countOrders } from './book';
import { applyOutcome, parseOutcome } from './outcome';
import { blockNumber, checkChainId, ChainError, readLogs, readRefusedRoles, type ChainCtx } from './chain';
import { readBody } from './body';
import { LOG_CHUNK_BLOCKS, MAX_LOG_CHUNKS_PER_TICK, MAX_PARTY_CHECK_ROUNDS, ConfigError, readConfig, REQUEST_BUDGET_MS, TICK_MS, type Config } from './config';
import type { Env } from './env';
import { buildFeed } from './feed';
import { intakeOrder } from './intake';
import { propose, type Proposal } from './match';
import { parseMarketId } from './routing';

export interface MarketDeps {
  fetch: typeof fetch;
  now(): number;
  log(line: string): void;
  /// The settler's daily refusal list. Throws when it cannot be read (the caller fails closed).
  refusedToday(maker: Hex): Promise<boolean>;
  /// Hands a proposal to the settler. `accepted` is false when the settler refuses (the Phase A stub always does).
  settle(body: unknown): Promise<{ accepted: boolean }>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/// The real dependencies. The settler is reached ONLY through `env.SETTLER.idFromName("settler")` (plan 6.1, one
/// path to send); no other code in this package names the settler.
export function realDeps(env: Env): MarketDeps {
  const settler = () => env.SETTLER.get(env.SETTLER.idFromName('settler'));
  return {
    fetch: (i, x) => fetch(i, x),
    now: () => Date.now(),
    log: (line) => console.log(line),
    async refusedToday(maker) {
      const res = await settler().fetch(new Request(`https://settler/refused/${maker}`));
      if (!res.ok) throw new Error('refusal list unreadable');
      const b = (await res.json()) as { refused?: unknown };
      if (typeof b.refused !== 'boolean') throw new Error('refusal list unreadable');
      return b.refused;
    },
    async settle(body) {
      const res = await settler().fetch(new Request('https://settler/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      if (!res.ok) return { accepted: false };
      const b = (await res.json().catch(() => null)) as { accepted?: unknown } | null;
      return { accepted: b?.accepted === true };
    },
  };
}

export class MatcherMarket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage.sql);
  }
  fetch(req: Request): Promise<Response> {
    return handleRequest(this.ctx, this.env, req, realDeps(this.env));
  }
  alarm(): Promise<void> {
    return handleAlarm(this.ctx, this.env, realDeps(this.env));
  }
}

const chainVerified = new WeakSet<object>();

function chainCtx(state: DurableObjectState, cfg: Config, deps: MarketDeps): ChainCtx & { verify(): Promise<void> } {
  const c: ChainCtx = {
    net: { fetch: deps.fetch, now: deps.now, deadlineAt: deps.now() + REQUEST_BUDGET_MS },
    rpcUrl: cfg.rpcUrl,
    exchange: cfg.exchange,
    chainId: cfg.chainId,
  };
  return {
    ...c,
    async verify() {
      if (chainVerified.has(state)) return;
      await checkChainId(c);
      chainVerified.add(state);
    },
  };
}

/// Plan 6.1: the market id this object serves is proven by its own identity, never taken on trust.
/// First request: the id is stored only if `idFromName(id)` equals this object's own id. Later: a request naming
/// another market is refused and alerted (a routing bug).
function identify(state: DurableObjectState, env: Env, header: string | null, alert: Alert): { ok: true; id: string } | { ok: false; res: Response } {
  const id = parseMarketId(header);
  if (id === null) return { ok: false, res: json(400, { ok: false, code: 'bad_market_id' }) };
  if (!env.MARKET.idFromName(id).equals(state.id)) {
    alert('market_identity_mismatch', `request names market ${id}, which is not this object`);
    return { ok: false, res: json(400, { ok: false, code: 'wrong_market_object' }) };
  }
  const stored = getMeta(state.storage.sql, 'market_id');
  if (stored === null) {
    setMeta(state.storage.sql, 'market_id', id);
    return { ok: true, id };
  }
  if (stored !== id) {
    alert('market_identity_mismatch', `object serves market ${stored}, a request named ${id}`);
    return { ok: false, res: json(400, { ok: false, code: 'wrong_market_object' }) };
  }
  return { ok: true, id };
}

export async function handleRequest(state: DurableObjectState, env: Env, req: Request, deps: MarketDeps): Promise<Response> {
  const sql = state.storage.sql;
  const alert = makeAlert(sql, deps.now, deps.log);
  const ident = identify(state, env, req.headers.get('x-market-id'), alert);
  if (!ident.ok) return ident.res;
  const marketId = BigInt(ident.id);

  let cfg: Config;
  try {
    cfg = readConfig(env);
  } catch (err) {
    return json(503, { ok: false, code: 'not_configured', detail: err instanceof ConfigError ? err.message : 'configuration is invalid' });
  }
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/book') {
    return json(200, buildFeed(marketId, allOrders(sql), deps.now()));
  }

  if (req.method === 'POST' && url.pathname === '/orders') {
    const rb = await readBody(req);
    if (!rb.ok) return json(413, { ok: false, code: 'bad_request' });
    const text = rb.text;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { ok: false, code: 'bad_request' });
    }
    const chain = chainCtx(state, cfg, deps);
    const result = await intakeOrder(
      { sql, cfg, chain, now: deps.now, alert, marketId, refusedToday: deps.refusedToday, verifyChain: chain.verify },
      body,
    );
    if (!result.ok) return json(result.status, { ok: false, code: result.code, ...(result.copy ? { copy: result.copy } : {}) });
    await ensureAlarm(state, deps);
    let handedOff = 0;
    try {
      handedOff = (await matchPass(state, cfg, deps, alert, [result.hash])).handedOff;
    } catch (err) {
      alert('match_failed', err instanceof Error ? err.name : 'error');
    }
    return json(200, { ok: true, hash: result.hash, booked: true, handedOff });
  }

  if (req.method === 'POST' && url.pathname === '/outcome') {
    const rb = await readBody(req);
    if (!rb.ok) return json(413, { ok: false, code: 'bad_request' });
    const text = rb.text;
    let parsed: ReturnType<typeof parseOutcome> = null;
    try {
      parsed = parseOutcome(JSON.parse(text));
    } catch {
      /* refused below */
    }
    if (!parsed) return json(400, { ok: false, code: 'bad_request' });
    applyOutcome(sql, parsed, alert);
    return json(200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/restart') {
    delMeta(sql, 'stopped');
    return json(200, { ok: true });
  }

  const del = /^\/orders\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
  if (req.method === 'DELETE' && del) {
    const removed = deleteByHash(sql, del[1].toLowerCase() as Hex);
    return json(200, { ok: true, removed });
  }

  return json(404, { ok: false, code: 'not_found' });
}

async function ensureAlarm(state: DurableObjectState, deps: MarketDeps): Promise<void> {
  if ((await state.storage.getAlarm()) === null) await state.storage.setAlarm(deps.now() + TICK_MS);
}

function serialize(p: Proposal) {
  const rec = (o: Proposal['taker']) => ({
    hash: o.hash,
    signature: o.signature,
    order: {
      salt: o.salt.toString(),
      maker: o.maker,
      marketId: o.marketId.toString(),
      option: o.option,
      isBuy: o.isBuy,
      price: o.price,
      size: o.size.toString(),
      expiration: o.expiration.toString(),
      nonce: o.nonce.toString(),
    },
  });
  return {
    kind: p.kind,
    marketId: p.marketId.toString(),
    taker: rec(p.taker),
    makers: p.makers.map(rec),
    fills: p.fills.map((f) => f.toString()),
    takerFill: p.takerFill.toString(),
  };
}

/// Tries each given order as a taker, oldest first. At most ONE proposal is handed to the settler per pass (one
/// match at a time; the book changes only when a settlement is reported back). Only the parties of a proposal are
/// checked against the contract's refused roles and the daily refusal list; a refused party is left out and the
/// match is proposed again without it. Everything fails closed: if either cannot be read, nothing is proposed.
export async function matchPass(state: DurableObjectState, cfg: Config, deps: MarketDeps, alert: Alert, takerHashes: Hex[] | null): Promise<{ handedOff: number }> {
  const sql = state.storage.sql;
  const nowS = Math.floor(deps.now() / 1000);
  // An order in a proposal the settler accepted is in flight until it reports: it is in no other proposal.
  const book = allOrders(sql).filter((o) => o.expiration > BigInt(nowS) && !o.inFlight);
  // Newest first: the later order of a crossing pair is the taker, so the resting order sets the price.
  const takers = (takerHashes === null ? book : book.filter((o) => takerHashes.includes(o.hash))).sort((a, b) => b.seq - a.seq);
  const nOptions = Number(getMeta(sql, 'n_options') ?? 0);
  if (takers.length === 0 || nOptions < 2) return { handedOff: 0 };
  // A stopped market matches nothing until a person restarts it (plan 6.2).
  if (getMeta(sql, 'stopped') !== null) return { handedOff: 0 };

  const chain = chainCtx(state, cfg, deps);
  const blocked = new Set<Hex>(); // refused roles and accounts refused for the day, found so far
  const clear = new Set<Hex>(); // checked and fine
  for (const taker of takers) {
    for (let round = 0; round < MAX_PARTY_CHECK_ROUNDS; round++) {
      const p = propose(taker, book, { nOptions, nowSeconds: nowS, blocked: (m) => blocked.has(m) });
      if (!p) break;
      const unchecked = [...new Set([p.taker.maker, ...p.makers.map((m) => m.maker)])].filter((a) => !clear.has(a));
      if (unchecked.length > 0) {
        try {
          await chain.verify();
          const roles = await readRefusedRoles(chain, unchecked);
          for (const a of unchecked) {
            if (roles.has(a) || (await deps.refusedToday(a))) blocked.add(a);
            else clear.add(a);
          }
        } catch (err) {
          alert('match_read_failed', err instanceof ChainError ? `${err.method} ${err.kind}` : 'refusal list unreadable');
          return { handedOff: 0 };
        }
        if (unchecked.some((a) => blocked.has(a))) continue; // propose again without the refused wallet
      }
      // Marked BEFORE the hand-off, so the settler's report cannot arrive ahead of the mark; released again if the
      // settler does not take the proposal.
      const hashes = [p.taker.hash, ...p.makers.map((m) => m.hash)];
      markInFlight(sql, hashes);
      let accepted = false;
      try {
        accepted = (await deps.settle(serialize(p))).accepted;
      } finally {
        if (!accepted) releaseInFlight(sql, hashes);
      }
      return { handedOff: 1 };
    }
  }
  return { handedOff: 0 };
}

/// The alarm tick: drop what expired, read cancels and nonce bumps from the chain, retry matching, and wake again
/// while the book is not empty.
export async function handleAlarm(state: DurableObjectState, env: Env, deps: MarketDeps): Promise<void> {
  const sql = state.storage.sql;
  const alert = makeAlert(sql, deps.now, deps.log);
  deleteExpired(sql, Math.floor(deps.now() / 1000));
  if (countOrders(sql) === 0) {
    delMeta(sql, 'log_cursor');
    return;
  }
  let cfg: Config;
  try {
    cfg = readConfig(env);
  } catch {
    alert('not_configured', 'the alarm found no usable configuration');
    await state.storage.setAlarm(deps.now() + TICK_MS);
    return;
  }
  try {
    await readCancels(state, cfg, deps);
  } catch (err) {
    alert('log_read_failed', err instanceof ChainError ? `${err.method} ${err.kind}` : 'error');
  }
  if (countOrders(sql) > 0) {
    try {
      await matchPass(state, cfg, deps, alert, null);
    } catch (err) {
      alert('match_failed', err instanceof Error ? err.name : 'error');
    }
    await state.storage.setAlarm(deps.now() + TICK_MS);
  } else {
    delMeta(sql, 'log_cursor');
  }
}

/// Plan 6.2 "Cancels made on chain": `Cancelled` drops that order, `NonceIncremented` drops every order of that
/// maker below the new nonce. None of it counts against the maker. The cursor moves only past blocks whose logs
/// were read and understood.
async function readCancels(state: DurableObjectState, cfg: Config, deps: MarketDeps): Promise<void> {
  const sql = state.storage.sql;
  const cursorRaw = getMeta(sql, 'log_cursor');
  if (cursorRaw === null) return;
  const chain = chainCtx(state, cfg, deps);
  await chain.verify();
  const latest = await blockNumber(chain);
  let cursor = BigInt(cursorRaw);
  for (let i = 0; i < MAX_LOG_CHUNKS_PER_TICK && cursor < latest; i++) {
    const from = cursor + 1n;
    const to = from + BigInt(LOG_CHUNK_BLOCKS) - 1n < latest ? from + BigInt(LOG_CHUNK_BLOCKS) - 1n : latest;
    const logs = await readLogs(chain, from, to);
    for (const l of logs) {
      if (l.kind === 'cancelled') deleteByHash(sql, l.orderHash);
      else deleteBelowNonce(sql, l.account, l.nonce);
    }
    cursor = to;
    setMeta(sql, 'log_cursor', cursor.toString());
  }
}
