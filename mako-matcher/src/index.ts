// mako-matcher Worker entry: routing only. Every market request is forwarded to that market's Durable Object,
// reached only through env.MARKET.idFromName(<canonical decimal id>) (plan 6.1).
//
//   POST   /market/:id/orders          place a signed order (the signature is the authentication)
//   DELETE /market/:id/orders/:hash    off-chain cancel; needs the shared secret in `x-matcher-secret` (the
//                                      Next.js side that sends it is slice 3)
//   GET    /book/:id                   the book feed, aggregated levels, at most 2 seconds old
import type { Env } from './env';
import { readBody } from './body';
import { FEED_MAX_AGE_MS } from './config';
import { parseMarketId } from './routing';

export { MatcherMarket } from './market';
export { MatcherSettler } from './settler';
export type { Env } from './env';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/// Constant-time comparison of two strings, without early exit on the first differing byte.
export function secretsEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/// Fails closed: with no secret configured, nothing guarded by it is accepted.
function checkSecret(env: Env, req: Request): Response | null {
  const secret = env.CANCEL_SECRET?.trim();
  if (!secret) return json(503, { ok: false, code: 'cancel_not_configured' });
  const given = req.headers.get('x-matcher-secret');
  if (given === null || !secretsEqual(given, secret)) return json(401, { ok: false, code: 'unauthorized' });
  return null;
}

function marketStub(env: Env, id: string) {
  return env.MARKET.get(env.MARKET.idFromName(id));
}

async function forward(env: Env, id: string, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-market-id', id);
  return marketStub(env, id).fetch(new Request(`https://market${path}`, { ...init, headers }));
}

export interface FeedDeps {
  cache: Cache;
  now(): number;
}

/// Serves the feed from a Cache API copy at most FEED_MAX_AGE_MS old, so a Durable Object request happens at most
/// once per 2 seconds per market per Cloudflare location. The age is judged from a header the copy carries.
export async function serveBook(env: Env, id: string, deps: FeedDeps): Promise<Response> {
  const key = new Request(`https://matcher.cache/book/${id}`);
  const hit = await deps.cache.match(key);
  if (hit) {
    const at = Number(hit.headers.get('x-cached-at'));
    if (Number.isFinite(at) && deps.now() - at >= 0 && deps.now() - at <= FEED_MAX_AGE_MS) {
      return new Response(hit.body, { status: hit.status, headers: hit.headers });
    }
  }
  const res = await forward(env, id, '/book', { method: 'GET' });
  if (!res.ok) return res;
  const body = await res.text();
  const out = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${Math.ceil(FEED_MAX_AGE_MS / 1000)}`, 'x-cached-at': String(deps.now()) },
  });
  await deps.cache.put(key, out.clone());
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter((p) => p !== '');

    if (parts[0] === 'book' && parts.length === 2) {
      if (req.method !== 'GET') return json(405, { ok: false, code: 'method_not_allowed' });
      const id = parseMarketId(parts[1]);
      if (id === null) return json(400, { ok: false, code: 'bad_market_id' });
      return serveBook(env, id, { cache: (caches as unknown as { default: Cache }).default, now: () => Date.now() });
    }

    // A person restarts a market the settler stopped (plan 6.2). Same shared secret as the cancel.
    if (parts[0] === 'market' && parts[2] === 'restart' && parts.length === 3) {
      const id = parseMarketId(parts[1]);
      if (id === null) return json(400, { ok: false, code: 'bad_market_id' });
      if (req.method !== 'POST') return json(405, { ok: false, code: 'method_not_allowed' });
      const denied = checkSecret(env, req);
      if (denied) return denied;
      return forward(env, id, '/restart', { method: 'POST' });
    }

    if (parts[0] === 'market' && parts[2] === 'orders') {
      const id = parseMarketId(parts[1]);
      if (id === null) return json(400, { ok: false, code: 'bad_market_id' });
      if (parts.length === 3 && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.ok) return json(413, { ok: false, code: 'bad_request' });
        return forward(env, id, '/orders', { method: 'POST', body: b.text, headers: { 'content-type': 'application/json' } });
      }
      if (parts.length === 4 && req.method === 'DELETE' && /^0x[0-9a-fA-F]{64}$/.test(parts[3])) {
        const denied = checkSecret(env, req);
        if (denied) return denied;
        return forward(env, id, `/orders/${parts[3]}`, { method: 'DELETE' });
      }
      return json(parts.length === 3 || parts.length === 4 ? 405 : 404, { ok: false, code: 'not_found' });
    }
    return json(404, { ok: false, code: 'not_found' });
  },
} satisfies ExportedHandler<Env>;
