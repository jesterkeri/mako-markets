import { db } from '@/db/client';
import { setReferrer } from '@/lib/competition/referrals';
import { checkSameOrigin } from '@/lib/csrf';
import { reserveSessionCheck } from '@/lib/name-check-budget';
import { isReferralTag, parseRefTag } from '@/lib/ref-tag';
import { getUserSession } from '@/lib/user-session';

// POST /api/user/referrer { code } -> { ok: true } | { error }
//
// A friend's referral code typed on the Me page, for someone who signed up on another device than the one that opened
// the link (owner change 2026-10-23). setReferrer writes users.ref in ONE conditional UPDATE, only when the code is a
// referral tag of a registered account, not the caller's own, the caller has no referral tag yet, and the caller's
// account was created at or after the competition start. Errors are fixed codes and never say whose code it is:
// 400 invalid | own | already | too_old, 401 unauthorized, 403 cross_origin, 429 rate_limited, 503 unavailable.
// Throttled per session before any database query, in the Me page's existing name-check window (30 a minute).
export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return Response.json({ error: 'cross_origin' }, { status: 403 });
  const budget = await reserveSessionCheck();
  if (budget === 'unauthorized') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (budget === 'limited') return Response.json({ error: 'rate_limited' }, { status: 429 });
  if (budget === 'unavailable') return Response.json({ error: 'unavailable' }, { status: 503 });
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let code: string | null = null;
  try {
    code = parseRefTag(((await req.json()) as { code?: unknown } | null)?.code);
  } catch {
    // Not JSON: the same answer as a bad code.
  }
  if (!code || !isReferralTag(code)) return Response.json({ error: 'invalid' }, { status: 400 });

  const result = await setReferrer(db, session.userId, code);
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: 400 });
}
