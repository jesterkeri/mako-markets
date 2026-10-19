import { DISPLAY_NAME_RE, displayNameKey, isReservedDisplayName } from '@/lib/display-name';
import { nameHeldByOther } from '@/lib/display-name-holder';
import { reserveNameCheck } from '@/lib/name-check-budget';
import { getUserSession } from '@/lib/user-session';

// GET /api/user/profile/name-available?name=... -> { available, reason? }
//
// The Me page's live check while a signed-in user types a display name. Advisory only: the save route's unique index
// is what enforces it. The caller's own current name counts as available. reason: 'invalid' | 'reserved' | 'taken'.
// Invalid and reserved names are answered first, by pure checks, with no database query (Codex UNIQUE_NAMES R2). Every
// other request is charged to the caller's signed session and to a site-wide ceiling (name-check-budget.ts) BEFORE any
// database query: 401 without a valid session cookie, 429 over a cap, 503 when the cap's store is down.
export async function GET(req: Request) {
  const name = (new URL(req.url).searchParams.get('name') ?? '').trim();
  if (!DISPLAY_NAME_RE.test(name)) return Response.json({ available: false, reason: 'invalid' });
  if (isReservedDisplayName(name)) return Response.json({ available: false, reason: 'reserved' });
  const budget = await reserveNameCheck();
  if (budget === 'unauthorized') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (budget === 'limited') return Response.json({ error: 'rate_limited' }, { status: 429 });
  if (budget === 'unavailable') return Response.json({ error: 'unavailable' }, { status: 503 });
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (await nameHeldByOther(displayNameKey(name), session.userId)) return Response.json({ available: false, reason: 'taken' });
  return Response.json({ available: true });
}
