import 'server-only';

import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';

import { upstashCommand } from './envio-budget';
import { USER_SESSION_COOKIE, verifySessionToken } from './user-session';

// A server-side cap on the Me page's live name check (Codex UNIQUE_NAMES R1 M2, R2): each check costs database queries,
// and the client's 400 ms pause and shared request bind only the app's own editors, not a script calling the route.
// Charged BEFORE any database query: the caller is identified by the signed session cookie, whose signature is checked
// without the database (the session row is read only after the charge). Two windows of 60 s in the Upstash store the
// Envio budget already uses, counted together in one atomic script: one per signed session, and one site-wide ceiling
// so many accounts cannot multiply the load. Fails closed: no store, no check (the editor reads 'checking'; Save still
// decides).

export const NAME_CHECKS_PER_MINUTE = 30;
export const NAME_CHECKS_PER_MINUTE_ALL = 300;

// INCR both windows (each starts on its first call); -1 over the session's cap, -2 over the site-wide one, else the
// session's count including this call.
const SCRIPT =
  "local a = redis.call('INCR', KEYS[1]) if a == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end " +
  "local g = redis.call('INCR', KEYS[2]) if g == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end " +
  'if a > tonumber(ARGV[2]) then return -1 end if g > tonumber(ARGV[3]) then return -2 end return a';

/// Reserve one check for the caller: 'ok', 'limited' (over a cap this minute), 'unauthorized' (no valid signed session
/// cookie) or 'unavailable' (store down or a broken reply).
export async function reserveNameCheck(): Promise<'ok' | 'limited' | 'unauthorized' | 'unavailable'> {
  const sid = verifySessionToken((await cookies()).get(USER_SESSION_COOKIE)?.value ?? '')?.sid;
  if (!sid) return 'unauthorized';
  // Hashed: the store never holds the session id.
  const key = `mako:namecheck:${createHash('sha256').update(sid).digest('hex').slice(0, 32)}`;
  try {
    const n = await upstashCommand(['EVAL', SCRIPT, 2, key, 'mako:namecheck:all', 60_000, NAME_CHECKS_PER_MINUTE, NAME_CHECKS_PER_MINUTE_ALL]);
    if (n === -1 || n === -2) return 'limited';
    // The script always counts this call, so anything but a whole number from 1 up is a broken reply: refuse, never
    // read it as 0 (adversary r13 on dba4225; envio-budget.ts is as strict).
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return 'unavailable';
    return 'ok';
  } catch {
    return 'unavailable';
  }
}
