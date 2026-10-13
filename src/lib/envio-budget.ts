import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

// One shared ceiling on every Envio GraphQL call Mako Market makes, across every Vercel instance (Codex ME_ROUNDS R5 and
// R6, Joshua 2026-10-13). Envio's development plan allows 100 queries a minute for the whole project, and two routes
// use it: rounds in Me (/api/me/rounds) and /stats. Every call, from either, reserves a slot here BEFORE it is sent, and
// a call without a slot is never sent. One atomic script checks and records two rolling-60 s logs at once:
//   - the GLOBAL log, all consumers: at most ENVIO_PER_MINUTE (95, a margin under Envio's 100);
//   - the consumer's own log: Me at most ME_ENVIO_PER_MINUTE (70), /stats at most STATS_ENVIO_PER_MINUTE (25).
// The two shares add up to the global cap, so neither can starve the other and together they never pass it, in either
// arrival order. Exact sliding windows, not fixed buckets (which allow double at a bucket edge).
//
// Capacity, stated conservatively: a Me discovery costs at least 8 calls and, for an account with the longest history
// the code allows on BOTH its lists (10,000 entries and 10,000 created rounds), 26. At 8 calls Me carries about 8
// discoveries a minute, roughly 17 people with Me open at once polling every 2 minutes; heavy accounts lower that. A
// paid Envio plan raises the ceiling (TASKS.md #203).
//
// The logs live in Upstash Redis as sorted sets of call times (REST API, one EVAL per call). Times come from Redis's own
// clock (TIME) at the moment the slot is recorded, never from an app instance: instance clocks differ and a request can
// take a while to arrive, and either would let a slot leave the window early (adversary on 0be93d3). If Upstash is not
// configured, unreachable or answers anything unexpected, the call is refused (fail closed): Me shows rounds
// unavailable and /stats shows its indexer figures unavailable, rather than risk Envio's limit. The same store keeps a
// short-lived map from a signed-in session to its account (me-rounds-caller.ts).

export const WINDOW_MS = 60_000;
export const ENVIO_PER_MINUTE = 95;
export const ME_ENVIO_PER_MINUTE = 70;
export const STATS_ENVIO_PER_MINUTE = 25;
export type EnvioConsumer = 'me' | 'stats';
const CONSUMER_CAP: Record<EnvioConsumer, number> = { me: ME_ENVIO_PER_MINUTE, stats: STATS_ENVIO_PER_MINUTE };
const TIMEOUT_MS = 2_000;

export class EnvioBudgetExhausted extends Error {
  override name = 'EnvioBudgetExhausted';
}
export class EnvioBudgetUnavailable extends Error {
  override name = 'EnvioBudgetUnavailable';
}

/// Two sliding-window logs on Redis's clock, checked and recorded together: drop calls older than the window from both,
/// refuse (0) if the global log or the consumer's log is at its cap, else record this call in both and return the
/// consumer's count including it. Atomic in Redis. KEYS: global log, consumer log. ARGV: window ms, global cap,
/// consumer cap, a unique member for this call.
const RESERVE_SCRIPT =
  "local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) " +
  "local win = tonumber(ARGV[1]) " +
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - win) redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - win) " +
  "if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end " +
  "local n = redis.call('ZCARD', KEYS[2]) " +
  "if n >= tonumber(ARGV[3]) then return 0 end " +
  "redis.call('ZADD', KEYS[1], now, ARGV[4]) redis.call('ZADD', KEYS[2], now, ARGV[4]) " +
  "redis.call('PEXPIRE', KEYS[1], win) redis.call('PEXPIRE', KEYS[2], win) return n + 1";
const GLOBAL_KEY = 'mako:envio:all:calls';
const consumerKey = (c: EnvioConsumer) => `mako:envio:${c}:calls`;

/// The Upstash REST endpoint and token: the names Upstash's own SDK reads, or the ones the Vercel Marketplace's
/// KV-style integration sets. Null when neither pair is set.
function upstashConfig(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL)?.trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN)?.trim();
  if (!url || !token || !/^https:\/\//.test(url)) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/// One Redis command over Upstash's REST API. Throws EnvioBudgetUnavailable on any failure; never logs the URL or token.
export async function upstashCommand(args: (string | number)[]): Promise<unknown> {
  const cfg = upstashConfig();
  if (!cfg) throw new EnvioBudgetUnavailable('not configured');
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new EnvioBudgetUnavailable('unreachable');
  }
  if (!res.ok) throw new EnvioBudgetUnavailable(`answered ${res.status}`);
  let body: { result?: unknown; error?: unknown };
  try {
    body = (await res.json()) as { result?: unknown; error?: unknown };
  } catch {
    throw new EnvioBudgetUnavailable('answer not JSON');
  }
  if (body === null || typeof body !== 'object' || body.error !== undefined || !('result' in body)) {
    throw new EnvioBudgetUnavailable('answer not usable');
  }
  return body.result;
}

/// Reserve one Envio call for `consumer` in the rolling minute, or throw. Called immediately before every GraphQL
/// request to the Envio project, from /api/me/rounds and /api/stats alike.
export async function reserveEnvioCall(consumer: EnvioConsumer): Promise<void> {
  const cap = CONSUMER_CAP[consumer];
  const n = await upstashCommand(['EVAL', RESERVE_SCRIPT, 2, GLOBAL_KEY, consumerKey(consumer), WINDOW_MS, ENVIO_PER_MINUTE, cap, randomUUID()]);
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > cap) throw new EnvioBudgetUnavailable('count not usable');
  if (n === 0) throw new EnvioBudgetExhausted(`${consumer}: rolling minute at the cap`);
}

/// The Redis key for a session's cached account: the session id is hashed, so no raw session id is ever stored.
export function sessionKey(sid: string): string {
  return `mako:me:sid:${createHash('sha256').update(sid).digest('hex')}`;
}
