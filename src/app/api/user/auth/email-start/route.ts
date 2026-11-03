// ----------------------------------------------------------------------------
// POST /api/user/auth/email-start
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.1): the sign-in dialog calls this right before Privy sends
// the email code. It issues an email ceremony that names no account and sets its secret in the httpOnly `mako_ec`
// cookie (SameSite=Strict, path /api/user/auth, 90 minutes); the row keeps only its SHA-256. Step A
// (/api/user/auth/email-verified) records on it the code entered next; only a ceremony recorded that way can ever bind
// this browser. Body: none. Answer: { ok: true }, the same for everyone. With the feature off it does nothing.
//
// Same-origin, and limited per visitor (by a hash of the client IP): each call inserts one row. The limit's store
// being unreachable lets the call through: a refusal here would stop every new-browser sign-in, and the cost of an
// unlimited call is one ceremony row, which can never bind without a fresh email code and the authenticator.
// ----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';

import { visitorIp } from '@/lib/avatar-budget';
import { checkSameOrigin } from '@/lib/csrf';
import { upstashCommand } from '@/lib/envio-budget';
import { issueCeremony, rememberedBrowserEnabled, setCeremonyCookie } from '@/lib/remembered-browser';

export const runtime = 'nodejs';

/// Email sign-ins started per visitor per minute.
const EMAIL_START_PER_MINUTE = 20;

// INCR the visitor's window (it starts on its first call); -1 over the cap, else the count including this call.
const SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end " +
  'if n > tonumber(ARGV[2]) then return -1 end return n';

/// false only when the store answered "over the cap".
async function withinLimit(ip: string): Promise<boolean> {
  try {
    const key = `mako:email-start:ip:${createHash('sha256').update(ip).digest('hex')}`;
    return (await upstashCommand(['EVAL', SCRIPT, 1, key, 60_000, EMAIL_START_PER_MINUTE])) !== -1;
  } catch {
    console.warn('[user/auth/email-start] rate limit store unavailable; allowed');
    return true;
  }
}

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  // The feature off (REMEMBERED_BROWSER_ENABLED unset): today's sign-in, no ceremony.
  if (!rememberedBrowserEnabled()) return Response.json({ ok: true });
  if (!(await withinLimit(visitorIp(req)))) return Response.json({ error: 'rate_limited' }, { status: 429 });
  let secret: string;
  try {
    secret = await issueCeremony();
  } catch (err) {
    console.error('[user/auth/email-start] insert failed', err instanceof Error ? err.name : 'unknown');
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
  setCeremonyCookie(await cookies(), secret);
  return Response.json({ ok: true });
}
