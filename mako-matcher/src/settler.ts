// MatcherSettler (plan 6.1): the ONE object that holds the operator key and sends a transaction. It is reached
// only through its one fixed name, from src/market.ts. The logic is in src/settle.ts; this file adds what only it may
// have: reading OPERATOR_PRIVATE_KEY, signing, and broadcasting. The bundle assertion fails the build if any
// other module does either.
import { DurableObject } from 'cloudflare:workers';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { makeAlert } from './alerts';
import { readBody } from './body';
import { checkChainId, rpc, type ChainCtx } from './chain';
import { ConfigError, readConfig, REQUEST_BUDGET_MS } from './config';
import type { Env } from './env';
import type { Outcome } from './outcome';
import { Settler, SETTLER_SCHEMA, utcDay, type SettleDeps } from './settle';

export { SETTLER_SCHEMA as REFUSED_AND_SETTLER_SCHEMA, utcDay };

export function isRefused(sql: SqlStorage, maker: string, nowMs: number): boolean {
  return sql.exec(`SELECT 1 FROM refused_accounts WHERE maker = ? AND utc_day = ?`, maker.toLowerCase(), utcDay(nowMs)).toArray().length > 0;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TICK_MS = 1_000;
const chainVerified = new WeakSet<object>();

/// The operator account, or null when the secret is missing or is not a 32-byte key. The value is never logged.
function operator(env: Env) {
  const k = env.OPERATOR_PRIVATE_KEY?.trim();
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) return null;
  try {
    return privateKeyToAccount(k as Hex);
  } catch {
    return null;
  }
}

/// K: a positive integer, or null (unset or malformed: the settler sends nothing).
export function parseK(raw: string | undefined): bigint | null {
  const v = raw?.trim();
  return v && /^[1-9][0-9]{0,8}$/.test(v) ? BigInt(v) : null;
}

export function parseFunder(raw: string | undefined): Hex | null {
  const v = raw?.trim();
  return v && isAddress(v, { strict: false }) ? (v.toLowerCase() as Hex) : null;
}

/// Every order hash in the proposal waiting, the transaction in flight, and every outcome not yet delivered: a market
/// keeps these marked.
export function heldHashes(sql: SqlStorage): string[] {
  const out = new Set<string>();
  for (const t of ['pending', 'in_flight']) {
    for (const r of sql.exec<{ body: string }>(`SELECT body FROM ${t}`).toArray()) {
      const p = JSON.parse(r.body) as { taker: { hash: string }; makers: { hash: string }[] };
      out.add(p.taker.hash);
      for (const m of p.makers) out.add(m.hash);
    }
  }
  for (const r of sql.exec<{ body: string }>(`SELECT body FROM outbox`).toArray()) {
    const o = JSON.parse(r.body) as { release?: string[]; dropped?: { hash: string }[] };
    for (const h of o.release ?? []) out.add(h);
    for (const d of o.dropped ?? []) out.add(d.hash);
  }
  return [...out];
}

export class MatcherSettler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const s of SETTLER_SCHEMA) ctx.storage.sql.exec(s);
  }

  /// The core, or the reason there cannot be one (no exchange address, no PRIMARY_RPC_URL: traces need it).
  private core(): { ok: true; settler: Settler } | { ok: false; reason: string } {
    let chain: ChainCtx;
    try {
      const cfg = readConfig(this.env);
      // The settler needs traces, which the public RPC does not give: the primary provider is required.
      if (!this.env.PRIMARY_RPC_URL?.trim()) return { ok: false, reason: 'held_no_primary_rpc' };
      chain = { net: { fetch: (i, x) => fetch(i, x), now: () => Date.now(), deadlineAt: Date.now() + REQUEST_BUDGET_MS }, rpcUrl: cfg.rpcUrl, exchange: cfg.exchange, chainId: cfg.chainId };
    } catch (err) {
      return { ok: false, reason: err instanceof ConfigError ? 'not_configured' : 'held_config' };
    }
    const sql = this.ctx.storage.sql;
    const acct = operator(this.env);
    const env = this.env;
    const deps: SettleDeps = {
      sql,
      chain,
      async verifyChain() {
        if (chainVerified.has(sql)) return;
        await checkChainId(chain);
        chainVerified.add(sql);
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      sender: acct ? (acct.address.toLowerCase() as Hex) : null,
      async signRaw(tx) {
        if (!acct) throw new Error('no key');
        return acct.signTransaction({ type: 'eip1559', value: 0n, ...tx });
      },
      async broadcast(raw) {
        const r = await rpc(chain.net, chain.rpcUrl, 'eth_sendRawTransaction', [raw]);
        if (!r.ok) throw new Error(r.kind);
      },
      K: parseK(env.K),
      funder: parseFunder(env.FUNDER_ADDRESS),
      gateGt: env.GATE_GT_PASSED === 'true',
      alert: makeAlert(sql, () => Date.now(), (l) => console.log(l)),
      async report(marketId, body: Outcome) {
        const res = await env.MARKET.get(env.MARKET.idFromName(marketId)).fetch(
          new Request('https://market/outcome', { method: 'POST', headers: { 'content-type': 'application/json', 'x-market-id': marketId }, body: JSON.stringify(body) }),
        );
        if (!res.ok) throw new Error('market refused the outcome');
      },
    };
    return { ok: true, settler: new Settler(deps) };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/refused\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && m) return json(200, { refused: isRefused(this.ctx.storage.sql, m[1], Date.now()) });
    if (req.method === 'GET' && url.pathname === '/held') return json(200, { hashes: heldHashes(this.ctx.storage.sql) });
    if (req.method === 'GET' && url.pathname === '/status') {
      const c = this.core();
      return c.ok ? json(200, await c.settler.status()) : json(503, { ok: false, reason: c.reason });
    }
    if (req.method === 'POST' && url.pathname === '/settle') {
      const b = await readBody(req, 65_536);
      if (!b.ok) return json(413, { ok: false, accepted: false, error: 'too_large' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(b.text);
      } catch {
        return json(400, { ok: false, accepted: false, error: 'bad_request' });
      }
      const c = this.core();
      if (!c.ok) {
        makeAlert(this.ctx.storage.sql, () => Date.now(), (l) => console.log(l))(c.reason, 'the settler sends nothing until this is configured');
        return json(503, { ok: false, accepted: false, error: c.reason });
      }
      const r = await c.settler.submit(parsed);
      if (r.accepted) await this.ctx.storage.setAlarm(Date.now());
      return json(r.accepted ? 200 : 503, { ok: r.accepted, accepted: r.accepted, ...(r.reason ? { error: r.reason } : {}) });
    }
    return json(404, { ok: false, accepted: false, error: 'not_found' });
  }

  async alarm(): Promise<void> {
    const c = this.core();
    if (!c.ok) {
      // With work waiting and no usable configuration, look again later; nothing is sent.
      await this.ctx.storage.setAlarm(Date.now() + 30 * TICK_MS);
      return;
    }
    await c.settler.run();
    if (c.settler.hasWork()) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }
}
