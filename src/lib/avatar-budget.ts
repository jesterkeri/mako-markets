import 'server-only';

import { upstashCommand } from './envio-budget';

// A site-wide cap on /api/avatar's Blob fetches (Codex PUBLIC_PROFILE R3 M2, owner's fix 2026-10-19). The route only
// accepts its one canonical path, so the CDN keeps one entry per photo version, but Next rewrites some query keys
// (`nxtPv` arrives as `v`) before a route sees the request, so the route cannot be sure every distinct public URL was
// refused. This bounds the cost whatever reaches it: 600 fetches a minute for the whole site, counted in the Upstash
// store the Envio budget already uses (one atomic script, a 60 s window that starts on its first call). Fails closed:
// over the cap, or the store down or answering anything unexpected, the photo is a 404 and the page shows the letter
// avatar.

export const AVATAR_FETCHES_PER_MINUTE = 600;
const KEY = 'mako:avatar:fetch';

// INCR the window (it starts on its first call); -1 over the cap, else the count including this call.
const SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end " +
  'if n > tonumber(ARGV[2]) then return -1 end return n';

/// Reserve one avatar fetch in the site-wide minute: true when the fetch may go ahead.
export async function reserveAvatarFetch(): Promise<boolean> {
  try {
    const n = await upstashCommand(['EVAL', SCRIPT, 1, KEY, 60_000, AVATAR_FETCHES_PER_MINUTE]);
    // The script always counts this call, so anything but a whole number from 1 up to the cap (or -1, over the cap) is
    // a broken reply: refuse, never read it as room to spare.
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= AVATAR_FETCHES_PER_MINUTE;
  } catch {
    return false;
  }
}
