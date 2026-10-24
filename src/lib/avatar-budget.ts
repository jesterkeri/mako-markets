import 'server-only';

import { createHash } from 'node:crypto';

import { upstashCommand } from './envio-budget';

// A site-wide cap on /api/avatar's Blob fetches (Codex PUBLIC_PROFILE R3 M2, owner's fix 2026-10-19). The route only
// accepts its one canonical path, so the CDN keeps one entry per photo version, but Next rewrites some query keys
// (`nxtPv` arrives as `v`) before a route sees the request, so the route cannot be sure every distinct public URL was
// refused. This bounds the cost whatever reaches it: 600 fetches a minute for the whole site, counted in the Upstash
// store the Envio budget already uses (one atomic script, a 60 s window that starts on its first call). Fails closed:
// over the cap, or the store down or answering anything unexpected, the photo is a 404 and the page shows the letter
// avatar.
//
// The shared budget is spent last (Codex PUBLIC_PROFILE R4 F2, owner decision Q-E, 2026-10-19): each visitor first gets
// AVATAR_VISITOR_PER_MINUTE requests a minute (by a hash of the client IP, same store, same script), then the account
// and version are checked in the database, and only a real photo's fetch reserves from the 600. Made-up addresses and
// wrong versions therefore never spend it, and one visitor cannot take it from everyone else.

export const AVATAR_FETCHES_PER_MINUTE = 600;
export const AVATAR_VISITOR_PER_MINUTE = 120;
const KEY = 'mako:avatar:fetch';

// INCR the window (it starts on its first call); -1 over the cap, else the count including this call.
const SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end " +
  'if n > tonumber(ARGV[2]) then return -1 end return n';

async function reserve(key: string, cap: number, windowMs = 60_000): Promise<boolean> {
  try {
    const n = await upstashCommand(['EVAL', SCRIPT, 1, key, windowMs, cap]);
    // The script always counts this call, so anything but a whole number from 1 up to the cap (or -1, over the cap) is
    // a broken reply: refuse, never read it as room to spare.
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= cap;
  } catch {
    return false;
  }
}

/// Reserve one avatar fetch in the site-wide minute: true when the fetch may go ahead.
export function reserveAvatarFetch(): Promise<boolean> {
  return reserve(KEY, AVATAR_FETCHES_PER_MINUTE);
}

/// The requesting visitor's IP as the platform reports it: `x-real-ip`, else the first `x-forwarded-for` entry. Every
/// request without one shares a single "unknown" bucket.
export function visitorIp(req: { headers: Headers }): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const first = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first || 'unknown';
}

/// Reserve one request in this visitor's minute: true when it may go ahead. The IP is stored only as a hash.
export function reserveAvatarVisitor(ip: string): Promise<boolean> {
  return reserve(`mako:avatar:ip:${createHash('sha256').update(ip).digest('hex')}`, AVATAR_VISITOR_PER_MINUTE);
}

// Share card loads that reach the chain (pnl-card-server.ts, Codex SHARE_CARDS R1 F1 and R2 F1), two budgets, each
// reserved just before the RPC calls it pays for, site-wide and across instances, in the same store and script. A load
// that makes no RPC call (a result card whose final facts the server already holds) reserves neither.
//  - Known bets (found in the leaderboard's bet ledger, mako_market_events, for this pool): 1 call, the pool read.
//    Reserved only after the ledger lookup found the bet, so made-up links can never spend it.
//  - Unknown bets (not in the ledger yet: placed in the last ~30 minutes, or made up): at most 3 calls (receipt, pool,
//    and the bet's block for a bet placed card). A flood of made-up links can only spend this one.
// shareClient reads MONAD_RPC_URL, else the public Monad RPC (about 15 requests a second, shared with the rest of the
// app). Windows of three seconds: one viewing of a bet placed link whose pool has settled is 3 loads within a second
// (the page, its redirect to the result page, and the image). Known 12 x 1 + unknown 6 x 3 = 30 calls per 3 s = 10 a
// second at most, two thirds of ~15, leaving 5 a second for the rest of the app; a 429 from the RPC is `unavailable`,
// a 503 with no-store.
export const CARD_LOADS_PER_WINDOW = 6;
export const KNOWN_CARD_LOADS_PER_WINDOW = 12;
export const CARD_LOAD_WINDOW_MS = 3_000;

/// The bet ledger lookup every card load that is not a kept result makes first (Codex SHARE_CARDS R3 F1): one indexed
/// read of mako_market_events in the shared database, so made-up links are capped site-wide before it, not only per
/// visitor. 30 in 3 s = 10 primary-key reads a second at most. Owner 2026-10-24: under a flood a card nobody opened
/// yet answers 429 (no-store) for a few seconds; a result card already kept on the server makes no lookup.
export const CARD_LOOKUPS_PER_WINDOW = 30;

/// Reserve one card ledger lookup in the site-wide window: true when it may query the database. Fails closed.
export function reserveCardLookup(): Promise<boolean> {
  return reserve('mako:card:lookup', CARD_LOOKUPS_PER_WINDOW, CARD_LOAD_WINDOW_MS);
}

/// A real card's account reads (registered check, name and photo, labels: about five indexed reads), made on every
/// render because no card image is cached. Only a URL that reached a real bet in a pool in the right state gets
/// here, so made-up links never spend it; a flood of one real card does, and then every card answers 429 (no-store)
/// for a few seconds. 15 in 3 s = 5 renders a second, about 25 reads a second at most.
export const CARD_RENDERS_PER_WINDOW = 15;

/// Reserve one card render's account reads in the site-wide window. Fails closed.
export function reserveCardRender(): Promise<boolean> {
  return reserve('mako:card:render', CARD_RENDERS_PER_WINDOW, CARD_LOAD_WINDOW_MS);
}

/// Reserve one unknown-bet card load in the site-wide window: true when it may read the chain. Fails closed.
export function reserveCardLoad(): Promise<boolean> {
  return reserve('mako:card:load', CARD_LOADS_PER_WINDOW, CARD_LOAD_WINDOW_MS);
}

/// Reserve one known-bet card load (one pool read) in its own site-wide window. Fails closed.
export function reserveKnownCardLoad(): Promise<boolean> {
  return reserve('mako:card:known', KNOWN_CARD_LOADS_PER_WINDOW, CARD_LOAD_WINDOW_MS);
}
