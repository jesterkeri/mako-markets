import 'server-only';

import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';

import { upstashCommand } from './envio-budget';
import { USER_SESSION_COOKIE, verifySessionToken } from './user-session';

// A server-side cap on the Me page's live name check (Codex UNIQUE_NAMES R1 M2, R2, R3), in two steps around the one
// session-row read, all in the Upstash store the Envio budget already uses (60 s windows, atomic scripts):
//   1. reserveSessionCheck, before any database query: the caller's signed session cookie (signature checked without
//      the database) may make 30 checks a minute. Its key is a hash of the session id.
//   2. reserveSiteCheck, after the session row proves the session is live: 300 checks a minute site-wide.
// So a session over its own cap, or a revoked session's cookie, never spends the shared ceiling (R3 M1, M2), and the
// session-row read itself is bounded by step 1. Fails closed: no store, no check (the editor reads 'checking'; Save
// still decides).

export const NAME_CHECKS_PER_MINUTE = 30;
export const NAME_CHECKS_PER_MINUTE_ALL = 300;

export type Reservation = 'ok' | 'limited' | 'unauthorized' | 'unavailable';

// INCR the window (it starts on its first call); -1 over the cap, else the count including this call.
const SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end " +
  'if n > tonumber(ARGV[2]) then return -1 end return n';

async function reserve(key: string, cap: number): Promise<Reservation> {
  try {
    const n = await upstashCommand(['EVAL', SCRIPT, 1, key, 60_000, cap]);
    if (n === -1) return 'limited';
    // The script always counts this call, so anything but a whole number from 1 up is a broken reply: refuse, never
    // read it as 0 (adversary r13 on dba4225; envio-budget.ts is as strict).
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return 'unavailable';
    return 'ok';
  } catch {
    return 'unavailable';
  }
}

/// Step 1: the caller's own window, before any database query. 'unauthorized' without a validly signed cookie.
export async function reserveSessionCheck(): Promise<Reservation> {
  const sid = verifySessionToken((await cookies()).get(USER_SESSION_COOKIE)?.value ?? '')?.sid;
  if (!sid) return 'unauthorized';
  // Hashed: the store never holds the session id.
  return reserve(`mako:namecheck:${createHash('sha256').update(sid).digest('hex').slice(0, 32)}`, NAME_CHECKS_PER_MINUTE);
}

/// Step 2: the site-wide window, only for a session the database has confirmed is live.
export function reserveSiteCheck(): Promise<Reservation> {
  return reserve('mako:namecheck:all', NAME_CHECKS_PER_MINUTE_ALL);
}
