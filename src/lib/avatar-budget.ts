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

async function reserve(key: string, cap: number): Promise<boolean> {
  try {
    const n = await upstashCommand(['EVAL', SCRIPT, 1, key, 60_000, cap]);
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
export function visitorIp(req: Request): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const first = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first || 'unknown';
}

/// Reserve one request in this visitor's minute: true when it may go ahead. The IP is stored only as a hash.
export function reserveAvatarVisitor(ip: string): Promise<boolean> {
  return reserve(`mako:avatar:ip:${createHash('sha256').update(ip).digest('hex')}`, AVATAR_VISITOR_PER_MINUTE);
}
