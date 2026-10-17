import { DISPLAY_NAME_RE, displayNameKey, isReservedDisplayName } from '@/lib/display-name';
import { nameHeldByOther } from '@/lib/display-name-holder';
import { reserveNameCheck } from '@/lib/name-check-budget';
import { getUserSession } from '@/lib/user-session';

// GET /api/user/profile/name-available?name=... -> { available, reason? }
//
// The Me page's live check while a signed-in user types a display name. Advisory only: the save route's unique index
// is what enforces it. The caller's own current name counts as available. reason: 'invalid' | 'reserved' | 'taken'.
// Capped per account (name-check-budget.ts): 429 over the cap, 503 when the cap's store is down, before any name query.
export async function GET(req: Request) {
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const name = (new URL(req.url).searchParams.get('name') ?? '').trim();
  if (!DISPLAY_NAME_RE.test(name)) return Response.json({ available: false, reason: 'invalid' });
  if (isReservedDisplayName(name)) return Response.json({ available: false, reason: 'reserved' });
  const budget = await reserveNameCheck(session.userId);
  if (budget === 'limited') return Response.json({ error: 'rate_limited' }, { status: 429 });
  if (budget === 'unavailable') return Response.json({ error: 'unavailable' }, { status: 503 });
  if (await nameHeldByOther(displayNameKey(name), session.userId)) return Response.json({ available: false, reason: 'taken' });
  return Response.json({ available: true });
}
