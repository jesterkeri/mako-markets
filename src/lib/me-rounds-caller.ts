import 'server-only';

import { cookies } from 'next/headers';

import { MONAD_TESTNET_ID } from './chain';
import { sessionKey, upstashCommand } from './envio-budget';
import { resolvePmActorAddress } from './private-markets/actor';
import { getUserSession, USER_SESSION_COOKIE, verifySessionToken } from './user-session';

// GET /api/me/rounds answers only for the signed-in caller's own account (Joshua 2026-10-13, Codex ME_ROUNDS R5), so it
// is not an open proxy for querying any wallet through Mako Market's Envio quota. The account is the one claims are
// sent from: the Safe for an email account, the wallet for a wallet account (the same resolver the pools use).
//
// The signed cookie is checked on every call (HMAC and expiry, no database). The session's account is then read from a
// 10-minute Upstash entry keyed by the HASHED session id, and only on a miss from the database (session row + Safe),
// so an open Me page polling every 2 minutes does not keep the database awake. A session signed out or expired within
// those 10 minutes can still discover its own public round ids until the entry lapses; it reveals nothing private.

const SESSION_ACCOUNT_TTL_S = 600;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export type MeRoundsCaller =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; error: 'sign_in_required' | 'not_your_account' | 'caller_unavailable' };

export async function authorizeMeRoundsCaller(requested: string): Promise<MeRoundsCaller> {
  const raw = (await cookies()).get(USER_SESSION_COOKIE)?.value;
  const payload = raw ? verifySessionToken(raw) : null;
  if (!payload) return { ok: false, status: 401, error: 'sign_in_required' };

  let account: string | null = null;
  const key = sessionKey(payload.sid);
  try {
    const cached = await upstashCommand(['GET', key]);
    if (typeof cached === 'string' && ADDRESS.test(cached)) account = cached;
  } catch {
    return { ok: false, status: 503, error: 'caller_unavailable' };
  }
  if (account === null) {
    const session = await getUserSession();
    if (!session) return { ok: false, status: 401, error: 'sign_in_required' };
    const actor = await resolvePmActorAddress(session, MONAD_TESTNET_ID);
    if (!actor.ok) return { ok: false, status: 403, error: 'not_your_account' };
    account = actor.address.toLowerCase();
    try {
      await upstashCommand(['SET', key, account, 'EX', SESSION_ACCOUNT_TTL_S]);
    } catch {
      return { ok: false, status: 503, error: 'caller_unavailable' };
    }
  }
  return account === requested.toLowerCase() ? { ok: true } : { ok: false, status: 403, error: 'not_your_account' };
}
