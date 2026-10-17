import { DISPLAY_NAME_RE, displayNameKey, isReservedDisplayName } from '@/lib/display-name';
import { nameHeldByOther } from '@/lib/display-name-holder';
import { getUserSession } from '@/lib/user-session';

// GET /api/user/profile/name-available?name=... -> { available, reason? }
//
// The Me page's live check while a signed-in user types a display name. Advisory only: the save route's unique index
// is what enforces it. The caller's own current name counts as available. reason: 'invalid' | 'reserved' | 'taken'.
export async function GET(req: Request) {
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const name = (new URL(req.url).searchParams.get('name') ?? '').trim();
  if (!DISPLAY_NAME_RE.test(name)) return Response.json({ available: false, reason: 'invalid' });
  if (isReservedDisplayName(name)) return Response.json({ available: false, reason: 'reserved' });
  if (await nameHeldByOther(displayNameKey(name), session.userId)) return Response.json({ available: false, reason: 'taken' });
  return Response.json({ available: true });
}
