import 'server-only';

import { createHash } from 'node:crypto';

import { upstashCommand } from './envio-budget';

// A server-side cap on the Me page's live name check (Codex UNIQUE_NAMES R1 M2): each check costs database queries,
// and the client's 400 ms pause and shared request bind only the app's own editors, not a script calling the route.
// One atomic counter per account per 60 s window in the Upstash store the Envio budget already uses. Fails closed: no
// store, no check (the editor reads 'checking'; Save still decides).

export const NAME_CHECKS_PER_MINUTE = 30;

// INCR, and start the window on the first call; returns the count including this call.
const SCRIPT = "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return n";

/// Reserve one check for this account: 'ok', 'limited' (over the cap this minute) or 'unavailable' (store down).
export async function reserveNameCheck(userId: string): Promise<'ok' | 'limited' | 'unavailable'> {
  // Hashed: the store never holds the internal account id.
  const key = `mako:namecheck:${createHash('sha256').update(userId).digest('hex').slice(0, 32)}`;
  try {
    const n = await upstashCommand(['EVAL', SCRIPT, 1, key, 60_000]);
    // The script always counts this call, so anything but a whole number from 1 up is a broken reply: refuse, never
    // read it as 0 (adversary r13 on dba4225; envio-budget.ts is as strict).
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return 'unavailable';
    return n <= NAME_CHECKS_PER_MINUTE ? 'ok' : 'limited';
  } catch {
    return 'unavailable';
  }
}
