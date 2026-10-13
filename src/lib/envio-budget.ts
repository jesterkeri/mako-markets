import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

// One shared ceiling on the Envio GraphQL calls rounds in Me makes, across every Vercel instance (Codex ME_ROUNDS R5,
// Joshua 2026-10-13). Envio's development plan allows 100 queries a minute for the whole project, and /stats uses the
// same project, so Me may spend at most ME_ENVIO_PER_MINUTE calls in ANY rolling 60 s (an exact sliding window, not
// fixed buckets, which would either allow double at a bucket edge or waste slots a discovery cannot use): every GraphQL
// request (each page included) reserves one slot here BEFORE it is sent, and a request with no slot is never sent. The
// other 30 a minute stay free for /stats. One discovery costs at least 8 calls (head, head round, and each list's page
// plus its empty terminator), so this carries about 8 discoveries a minute: with Me asking every 2 minutes, roughly
// 17 people with Me open at once. A paid Envio plan raises the ceiling (TASKS.md #203).
//
// The log lives in Upstash Redis as a sorted set of call times (REST API, one EVAL per call, atomic: drop entries older
// than 60 s, count, add this call if under the cap). Times come from Redis's own clock (TIME) at the moment the slot is
// recorded, never from an app instance: instance clocks differ and a request can take a while to arrive, and either
// would let a slot leave the window early (adversary on 0be93d3). If Upstash is
// not configured, unreachable or answers anything unexpected, the call is refused: Me shows rounds unavailable rather
// than risk Envio's limit (fail closed). The same store keeps a short-lived map from a signed-in session to its
// account (me-rounds-caller.ts), so binding the route to the caller does not wake the database on every poll.

export const WINDOW_MS = 60_000;
export const ME_ENVIO_PER_MINUTE = 70;
const TIMEOUT_MS = 2_000;

export class EnvioBudgetExhausted extends Error {
  override name = 'EnvioBudgetExhausted';
}
export class EnvioBudgetUnavailable extends Error {
  override name = 'EnvioBudgetUnavailable';
}

/// Sliding-window log on Redis's clock: drop calls older than the window, refuse (0) at the cap, else record this call
/// and return the count including it. Atomic in Redis. ARGV: window ms, cap, a unique member for this call.
const RESERVE_SCRIPT =
  "local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) " +
  "local win = tonumber(ARGV[1]) " +
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - win) " +
  "local n = redis.call('ZCARD', KEYS[1]) " +
  "if n >= tonumber(ARGV[2]) then return 0 end " +
  "redis.call('ZADD', KEYS[1], now, ARGV[3]) redis.call('PEXPIRE', KEYS[1], win) return n + 1";
const LOG_KEY = 'mako:envio:me:calls';

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

/// Reserve one Envio call in the rolling minute, or throw. Called immediately before every GraphQL request Me sends.
export async function reserveEnvioCall(): Promise<void> {
  const n = await upstashCommand(['EVAL', RESERVE_SCRIPT, 1, LOG_KEY, WINDOW_MS, ME_ENVIO_PER_MINUTE, randomUUID()]);
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > ME_ENVIO_PER_MINUTE) throw new EnvioBudgetUnavailable('count not usable');
  if (n === 0) throw new EnvioBudgetExhausted('rolling minute at the cap');
}

/// The Redis key for a session's cached account: the session id is hashed, so no raw session id is ever stored.
export function sessionKey(sid: string): string {
  return `mako:me:sid:${createHash('sha256').update(sid).digest('hex')}`;
}
