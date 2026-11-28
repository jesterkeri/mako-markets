// MatcherMarket: one Durable Object per market (plan 6.1). It is single-threaded, so intake and matching are
// serial; the book lives in its SQLite storage. It is reached only through env.MARKET.idFromName(<canonical id>).
import { DurableObject } from 'cloudflare:workers';
import type { Hex } from 'viem';
import { makeAlert, type Alert } from './alerts';
import { allOrders, feedOrders, cancelOrder, deleteBelowNonce, deleteExpired, dropRefused, delMeta, getMeta, getOrder, markInFlight, marksOlderThan, migrate, releaseInFlight, setMeta, countOrders } from './book';
import { applyOutcome, parseOutcome } from './outcome';
import { blockNumber, checkChainId, ChainError, readLogs, readRefusedRoles, type ChainCtx } from './chain';
import { readBody } from './body';
import { STALE_MARK_MS, REFUSED_DROP_KEEP_MS, LOG_CHUNK_BLOCKS, MAX_LOG_CHUNKS_PER_TICK, ConfigError, readConfig, REQUEST_BUDGET_MS, ROLE_CHUNK, TICK_MS, TICK_WORK, IDLE_RECHECK_MS, type Config } from './config';
import type { Env } from './env';
import { buildFeed } from './feed';
import { utcDay } from './settle';
import { intakeOrder } from './intake';
import { propose, type Proposal } from './match';
import { parseMarketId } from './routing';

export interface MarketDeps {
  fetch: typeof fetch;
  now(): number;
  log(line: string): void;
  /// The settler's daily refusal list. Throws when it cannot be read (the caller fails closed).
  refusedToday(maker: Hex): Promise<boolean>;
  /// The settler's refusal rows from UTC day `since` (YYYY-MM-DD) through today, lowercase. Throws when unreadable.
  refusalsSince(since: string): Promise<{ maker: Hex; day: string }[]>;
  /// Hands a proposal to the settler. `accepted: false` only for the settler's explicit refusal; throws when the
  /// answer is lost or unreadable (the proposal may have been taken).
  settle(body: unknown): Promise<{ accepted: boolean }>;
  /// Every order hash the settler still holds a proposal or an undelivered outcome for. Throws when unreadable.
  held(): Promise<Set<string>>;
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
    async refusalsSince(since) {
      const res = await settler().fetch(new Request(`https://settler/refused?since=${since}`));
      if (!res.ok) throw new Error('refusal list unreadable');
      const b = (await res.json().catch(() => null)) as { refusals?: unknown } | null;
      const ok = (r: unknown) => {
        const x = r as { maker?: unknown; day?: unknown } | null;
        return typeof x?.maker === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x.maker) && typeof x.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.day);
      };
      if (!Array.isArray(b?.refusals) || !b.refusals.every(ok)) throw new Error('refusal list unreadable');
      return (b.refusals as { maker: string; day: string }[]).map((r) => ({ maker: r.maker.toLowerCase() as Hex, day: r.day }));
    },
    async settle(body) {
      const res = await settler().fetch(new Request('https://settler/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      return handoffAnswer(await res.text());
    },
    async held() {
      const res = await settler().fetch(new Request('https://settler/held'));
      if (!res.ok) throw new Error('settler holds unreadable');
      const b = (await res.json().catch(() => null)) as { hashes?: unknown } | null;
      if (!Array.isArray(b?.hashes) || !b.hashes.every((x) => typeof x === 'string')) throw new Error('settler holds unreadable');
      return new Set(b.hashes as string[]);
    },
  };
}

/// The settler's answer to a hand-off. Its handler answers every outcome, refusals included, as JSON with a boolean
/// `accepted`; anything else (a runtime error page, a cut body) is not an answer, whatever the status.
export function handoffAnswer(text: string): { accepted: boolean } {
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    throw new Error('hand-off answer unreadable');
  }
  const a = (b as { accepted?: unknown } | null)?.accepted;
  if (typeof a !== 'boolean') throw new Error('hand-off answer unreadable');
  return { accepted: a };
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
    return json(200, buildFeed(marketId, feedOrders(sql), deps.now()));
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
    // `handedOff`: proposals sent to the settler (0 or 1); `handoff`: its answer to that one (Codex MATCHER R6 F2).
    let handedOff = 0;
    let handoff: HandoffAnswer | null = null;
    // this booking, not just this signed order: the same hash can be removed and booked again meanwhile (Codex R8 F1)
    const seq = result.order.seq;
    try {
      const r = await matchPass(state, cfg, deps, alert, [result.hash]);
      handedOff = r.handedOff;
      handoff = r.answer ?? null;
    } catch (err) {
      alert('match_failed', err instanceof Error ? err.name : 'error');
    }
    // Removed as refused while this request ran, by any path and at any point after the insert: the account is excluded
    // for a day covering this booking (Codex MATCHER R7 F3, R8 F2/F3, adversary R18/R19). Read and cleared.
    if (sql.exec(`DELETE FROM refused_drops WHERE seq = ? RETURNING seq`, seq).toArray().length > 0) {
      return json(400, { ok: false, code: 'account_refused', hash: result.hash });
    }
    // `booked`: this booking is on the book now (resting or in flight); removed for another reason (a cancel, a fill,
    // expiry) meanwhile, or flagged to go when its match reports (a cancel, expiry or nonce bump while in flight): false
    // (adversary R22).
    const booked = sql.exec(`SELECT 1 FROM orders WHERE seq = ? AND remove_at_release = 0`, seq).toArray().length > 0;
    return json(200, { ok: true, hash: result.hash, booked, handedOff, handoff });
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
    applyOutcome(sql, parsed, alert, deps.now());
    return json(200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/restart') {
    delMeta(sql, 'stopped');
    return json(200, { ok: true });
  }

  const del = /^\/orders\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
  if (req.method === 'DELETE' && del) {
    // `removed`: gone now; `atRelease`: in a match now, so it goes when that match reports (and is never matched again)
    const r = cancelOrder(sql, del[1].toLowerCase() as Hex);
    return json(200, { ok: true, removed: r === 'removed', atRelease: r === 'at_release' });
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
    bookedAt: o.createdAt,
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
/// match at a time; the book changes only when a settlement is reported back). The first proposal of a pass reads
/// every maker on the book against the contract's refused roles and the settler's daily refusal list at once (Codex
/// MATCHER R4 F1: checking only a proposal's parties found refused wallets a few per tick and needed a cache whose
/// expiry undid the progress); a refused wallet is left out of every search in the pass. Nothing is carried to the
/// next pass. Everything fails closed: if either cannot be read, nothing is proposed.
/// The result: `handedOff`; `resumeBelow`, the cursor a spread full pass continues below (null: do not move it); and
/// `finished`, true only when every given taker was tried and nothing stopped the pass early.
/// `budgetStop`: the pass stopped before a taker because the work budget was spent (not a failure: the next tick
/// continues from that taker); `tried`: how many takers it searched.
/// `answer`: the settler's answer to the hand-off, when there was one (accepted, an explicit refusal such as `busy` or
/// `party_refused`, or unknown: the answer was lost and the marks stay).
export type PassResult = { handedOff: number; resumeBelow: number | null; finished: boolean; budgetStop?: boolean; tried?: number; answer?: HandoffAnswer };
export type HandoffAnswer = 'accepted' | 'refused' | 'unknown';

export async function matchPass(state: DurableObjectState, cfg: Config, deps: MarketDeps, alert: Alert, takerHashes: Hex[] | null, budget?: number): Promise<PassResult> {
  const sql = state.storage.sql;
  const nowS = Math.floor(deps.now() / 1000);
  // An order in a proposal the settler accepted is in flight until it reports: it is in no other proposal.
  const book = allOrders(sql).filter((o) => o.expiration > BigInt(nowS) && !o.inFlight);
  // Newest first: the later order of a crossing pair is the taker, so the resting order sets the price.
  const takers = (takerHashes === null ? book : book.filter((o) => takerHashes.includes(o.hash))).sort((a, b) => b.seq - a.seq);
  const nOptions = Number(getMeta(sql, 'n_options') ?? 0);
  if (takers.length === 0 || nOptions < 2) return { handedOff: 0, resumeBelow: null, finished: true };
  // A stopped market matches nothing until a person restarts it (plan 6.2).
  if (getMeta(sql, 'stopped') !== null) return { handedOff: 0, resumeBelow: null, finished: false };

  const chain = chainCtx(state, cfg, deps);
  // refused roles and accounts refused for the day, lowercase; read at the first proposal of this pass (below)
  const blocked = new Set<Hex>();
  let checked = false;
  const lc = (a: Hex) => a.toLowerCase() as Hex;
  const opts = { nOptions, nowSeconds: nowS, blocked: (m: Hex) => blocked.has(lc(m)), work: { used: 0 } };
  const work = opts.work;
  let tried = 0;
  for (const taker of takers) {
    // Spent: stop before this taker (never before the first), and the next tick starts with it.
    if (budget !== undefined && tried > 0 && work.used >= budget) return { handedOff: 0, resumeBelow: taker.seq + 1, finished: false, budgetStop: true, tried };
    tried++;
    let p = propose(taker, book, opts);
    if (!p) continue;
    if (!checked) {
      // every maker this pass can propose, in at most ceil(MAX_BOOK_ORDERS / ROLE_CHUNK) multicalls plus one read
      try {
        await chain.verify();
        const makers = [...new Set(book.map((o) => lc(o.maker)))];
        for (let i = 0; i < makers.length; i += ROLE_CHUNK) {
          for (const a of await readRefusedRoles(chain, makers.slice(i, i + ROLE_CHUNK))) blocked.add(lc(a));
        }
        for (const a of await syncRefusals(sql, deps)) blocked.add(a);
      } catch (err) {
        alert('match_read_failed', err instanceof ChainError ? `${err.method} ${err.kind}` : 'refusal list unreadable');
        return { handedOff: 0, resumeBelow: null, finished: false };
      }
      checked = true;
      // every party of every proposal from here on is a checked maker of `book`; search again without the refused
      if ([p.taker.maker, ...p.makers.map((m) => m.maker)].some((a) => blocked.has(lc(a)))) p = propose(taker, book, opts);
      if (!p) continue;
    }
    // Marked BEFORE the hand-off, so the settler's report cannot arrive ahead of the mark; released again if the
    // settler does not take the proposal.
    const hashes = [p.taker.hash, ...p.makers.map((m) => m.hash)];
    // The book was read before the chain reads above, and a fetch or another pass can run during them. Checked
    // again here with no await before the mark: every order still booked, not in flight, and unfilled since the
    // read. Otherwise this pass hands off nothing and the next one proposes from the book as it now is.
    // The same booking, by `seq`: a hash removed and booked again since is a newer order with another time and
    // priority (Codex MATCHER R8 F1).
    const snap = new Map(book.map((o) => [o.hash, o]));
    if (hashes.some((h) => {
      const now = getOrder(sql, h);
      const was = snap.get(h);
      return !now || !was || now.seq !== was.seq || now.inFlight || now.filled !== was.filled;
    })) return { handedOff: 0, resumeBelow: taker.seq + 1, finished: false }; // this taker again next time
    markInFlight(sql, hashes, deps.now());
    // Only the settler's explicit refusal releases the marks. A lost or unreadable answer may hide an acceptance
    // (the settler stores the proposal before it answers), so the marks stay until the settler reports, or until
    // the stale-mark check finds the settler does not hold them.
    let answer: HandoffAnswer = 'unknown';
    try {
      answer = (await deps.settle(serialize(p))).accepted ? 'accepted' : 'refused';
    } catch {
      alert('handoff_unconfirmed', 'the settler did not answer the hand-off; its orders stay marked until it is known');
    }
    if (answer === 'refused') releaseInFlight(sql, hashes, deps.now());
    return { handedOff: 1, resumeBelow: taker.seq, finished: false, answer };
  }
  return { handedOff: 0, resumeBelow: takers.length > 0 ? takers[takers.length - 1].seq : null, finished: true, tried };
}

/// Codex MATCHER R3 F2: the alarm's full pass, spread over ticks with a bound per tick. Each tick searches takers
/// newest first, continuing below the stored cursor and wrapping back to the newest, until TICK_WORK units of search
/// work are spent (counted by the search itself, adversary R9: a count of takers did not bound the work), and always
/// at least one taker, so every booked order is tried at least once per rotation however often the book changes: no
/// fixed prefix (R2). A rotation takes at most one tick per order, and on the worst book found about 80. A whole rotation that saw the same book throughout and handed nothing off marks
/// that book idle, and an idle book is not searched again until it changes (an order, a fill, an in-flight mark,
/// the UTC day of the refusal list) or IDLE_RECHECK_MS passes.
export async function spreadPass(state: DurableObjectState, cfg: Config, deps: MarketDeps, alert: Alert): Promise<{ handedOff: number; tried: number; skipped: boolean }> {
  const sql = state.storage.sql;
  const nowMs = deps.now();
  const all = allOrders(sql);
  const print = await bookPrint(all, nowMs);
  const idleAt = Number(getMeta(sql, 'idle_at') ?? '0');
  if (getMeta(sql, 'idle_fp') === print && nowMs - idleAt < IDLE_RECHECK_MS) return { handedOff: 0, tried: 0, skipped: true };
  delMeta(sql, 'idle_fp');
  if (getMeta(sql, 'rot_fp') === null) startRotation(sql, print);
  else if (getMeta(sql, 'rot_fp') !== print) setMeta(sql, 'rot_clean', '0');
  const nowS = BigInt(Math.floor(nowMs / 1000));
  const book = all.filter((o) => o.expiration > nowS && !o.inFlight).sort((a, b) => b.seq - a.seq);
  const cur = getMeta(sql, 'tick_cursor');
  const below = cur === null ? book : book.filter((o) => o.seq < Number(cur));
  const r = await matchPass(state, cfg, deps, alert, below.map((o) => o.hash), TICK_WORK);
  // Stopping for the budget is not a failure: the rotation can still end clean.
  if (r.handedOff > 0 || (!r.finished && !r.budgetStop)) setMeta(sql, 'rot_clean', '0');
  if (r.finished) {
    // The rotation is complete: idle if it was clean, then start the next one from the newest order.
    if (getMeta(sql, 'rot_clean') === '1' && getMeta(sql, 'rot_fp') === print) {
      setMeta(sql, 'idle_fp', print);
      setMeta(sql, 'idle_at', String(nowMs));
    }
    startRotation(sql, print);
  } else if (r.resumeBelow !== null) {
    setMeta(sql, 'tick_cursor', String(r.resumeBelow));
  }
  return { handedOff: r.handedOff, tried: r.tried ?? 0, skipped: false };
}

function startRotation(sql: SqlStorage, print: string): void {
  setMeta(sql, 'rot_fp', print);
  setMeta(sql, 'rot_clean', '1');
  delMeta(sql, 'tick_cursor');
}

/// What a search's answer depends on that the book shows: each order's hash, fill and in-flight mark, and the UTC
/// day (the settler's refusal list is per day). SHA-256, hex.
async function bookPrint(all: ReturnType<typeof allOrders>, nowMs: number): Promise<string> {
  const text = `${Math.floor(nowMs / 86_400_000)}|` + all.map((o) => `${o.hash}:${o.filled}:${o.inFlight ? 1 : 0}`).join(',');
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/// The alarm tick: drop what expired, read cancels and nonce bumps from the chain, retry matching, and wake again
/// while the book is not empty.
export async function handleAlarm(state: DurableObjectState, env: Env, deps: MarketDeps): Promise<void> {
  const sql = state.storage.sql;
  const alert = makeAlert(sql, deps.now, deps.log);
  deleteExpired(sql, Math.floor(deps.now() / 1000));
  // refusal records no intake can still be waiting for (on an emptied book too)
  sql.exec(`DELETE FROM refused_drops WHERE at < ?`, deps.now() - REFUSED_DROP_KEEP_MS);
  if (countOrders(sql) === 0) {
    delMeta(sql, 'log_cursor');
    delMeta(sql, 'refusals_since'); // an empty book has nothing to drop: the next read starts from its own day
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
  await releaseStaleMarks(sql, deps, alert);
  // Every tick, idle or not, so each market drops a refused account's orders within one tick of the refusal, whether or
  // not it ever proposes that account (Codex MATCHER R6 F1, plan 6.2). Unreadable: kept and alerted; the matching pass
  // reads again and proposes nothing without it.
  try {
    await syncRefusals(sql, deps);
  } catch {
    alert('refusal_list_unreadable', 'the settler refusal list could not be read; refused accounts are not dropped this tick');
  }
  if (countOrders(sql) > 0) {
    try {
      await spreadPass(state, cfg, deps, alert);
    } catch (err) {
      alert('match_failed', err instanceof Error ? err.name : 'error');
    }
    await state.storage.setAlarm(deps.now() + TICK_MS);
  } else {
    delMeta(sql, 'log_cursor');
  }
}

/// Plan 6.2: reads every settler refusal since this book's last good read (or, with none, since the day its oldest order
/// was booked, a day back), drops the orders each one covers (dropRefused, which records them), and returns the
/// accounts refused today, lowercase.
/// Throws when the settler cannot be read; callers match nothing then. The tick and every matching pass (intake too)
/// call it, so no order booked on a refused day is proposed after that day turns (adversary R14, R15). The next read
/// starts a day back, so a row the settler stamps with a day the market's clock has just left is read again.
async function syncRefusals(sql: SqlStorage, deps: MarketDeps): Promise<Set<Hex>> {
  const now = deps.now();
  const oldest = sql.exec<{ t: number | null }>(`SELECT MIN(created_at) AS t FROM orders`).one().t ?? now;
  // a day before the oldest order's day: the settler may stamp a refusal covering it with the day before (its clock
  // behind; DAY_EDGE_SLACK_MS), and the first read must see that row too (Codex MATCHER R7 F1)
  const rows = await deps.refusalsSince(getMeta(sql, 'refusals_since') ?? utcDay(Math.min(oldest, now) - 86_400_000));
  dropRefused(sql, rows, now);
  setMeta(sql, 'refusals_since', utcDay(now - 86_400_000));
  const today = utcDay(now);
  return new Set(rows.filter((r) => r.day >= today).map((r) => r.maker));
}

/// A mark set for a hand-off the settler never received (this object was replaced during the hand-off) would keep
/// its orders out of every proposal for good. A mark older than STALE_MARK_MS that the settler does not hold is
/// released. Unreadable settler: every mark is kept.
async function releaseStaleMarks(sql: SqlStorage, deps: MarketDeps, alert: Alert): Promise<void> {
  if (marksOlderThan(sql, deps.now() - STALE_MARK_MS).length === 0) return;
  let held: Set<string>;
  try {
    held = await deps.held();
  } catch {
    return;
  }
  // Read again after the await: a mark set or released meanwhile is judged on its current state.
  const free = marksOlderThan(sql, deps.now() - STALE_MARK_MS).filter((h) => !held.has(h));
  if (free.length === 0) return;
  releaseInFlight(sql, free, deps.now());
  alert('stale_mark_released', `${free.length} order(s) marked for a hand-off the settler does not hold`);
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
      if (l.kind === 'cancelled') cancelOrder(sql, l.orderHash);
      else deleteBelowNonce(sql, l.account, l.nonce);
    }
    // An intake booked during the read may have moved the cursor back (or the cursor is gone): that value stands and
    // the next tick reads from it. Writing `to` over it would skip that order's cancels.
    const nowRaw = getMeta(sql, 'log_cursor');
    if (nowRaw === null || BigInt(nowRaw) !== cursor) return;
    cursor = to;
    setMeta(sql, 'log_cursor', cursor.toString());
  }
}
