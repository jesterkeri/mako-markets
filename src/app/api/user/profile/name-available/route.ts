import { DISPLAY_NAME_RE, displayNameKey, isReservedDisplayName } from '@/lib/display-name';
import { nameHeldByOther } from '@/lib/display-name-holder';
import { reserveSessionCheck, reserveSiteCheck, type Reservation } from '@/lib/name-check-budget';
import { getUserSession } from '@/lib/user-session';

// GET /api/user/profile/name-available?name=... -> { available, reason? }
//
// The Me page's live check while a signed-in user types a display name. Advisory only: the save route's unique index
// is what enforces it. The caller's own current name counts as available. reason: 'invalid' | 'reserved' | 'taken'.
// Invalid and reserved names are answered first, by pure checks, with no database query (Codex UNIQUE_NAMES R2). Every
// other request is charged to the caller's signed session BEFORE any database query, then the session row is read, and
// only a live session is charged to the site-wide ceiling (R3), before the name query (name-check-budget.ts): 401
// without a valid or live session, 429 over a cap, 503 when the cap's store is down.
export async function GET(req: Request) {
  const name = (new URL(req.url).searchParams.get('name') ?? '').trim();
  if (!DISPLAY_NAME_RE.test(name)) return Response.json({ available: false, reason: 'invalid' });
  if (isReservedDisplayName(name)) return Response.json({ available: false, reason: 'reserved' });
  const own = await reserveSessionCheck();
  if (own !== 'ok') return refused(own);
  const session = await getUserSession();
  if (!session) return refused('unauthorized');
  const site = await reserveSiteCheck();
  if (site !== 'ok') return refused(site);
  if (await nameHeldByOther(displayNameKey(name), session.userId)) return Response.json({ available: false, reason: 'taken' });
  return Response.json({ available: true });
}

const refused = (why: Exclude<Reservation, 'ok'>) =>
  why === 'unauthorized'
    ? Response.json({ error: 'unauthorized' }, { status: 401 })
    : why === 'limited'
      ? Response.json({ error: 'rate_limited' }, { status: 429 })
      : Response.json({ error: 'unavailable' }, { status: 503 });
