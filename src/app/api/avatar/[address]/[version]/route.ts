import { db } from '@/db/client';
import { reserveAvatarFetch, reserveAvatarVisitor, visitorIp } from '@/lib/avatar-budget';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { registeredAddresses, resolveStoredIdentities } from '@/lib/leaderboard/identity';
import { avatarVersion } from '@/lib/public-avatar';

// GET /api/avatar/<address>/<version> -> the account's profile photo, streamed.
// The public address of a photo (Joshua 2026-10-17, Codex PUBLIC_PROFILE R1 M2): the stored Blob URL's path carries
// the internal account id, so the leaderboard, profiles and comments link here instead. Streamed, never redirected (a
// redirect would hand out the stored URL). Only this app's own Blob store is fetched (resolveStoredIdentities keeps
// app-owned photos only), so this cannot be pointed at another host. Cached at most a minute, browser and CDN alike
// (Joshua 2026-10-17: a removed photo must stop being served, not linger in a year-long cache); `version` only makes a
// new photo show at once and is required: an old or made-up one is a 404. No account or no photo: 404 too, and the
// page shows the letter avatar.
//
// One canonical path per photo version, so the CDN keeps one entry each (Codex PUBLIC_PROFILE R2 M2, R3 M2): a
// lower-case address, a 12-hex version and no query string at all, each checked before any database query or Blob
// fetch. Next rewrites some query keys before a route sees them (`?nxtPv=` arrives as `?v=`), so a version in the query
// could not be trusted to be the URL the CDN saw; with no query accepted, any such key is still a 404. Then, in this
// order (Codex PUBLIC_PROFILE R4 F2, owner decision Q-E): a per-visitor limit, the account and version checks, and only
// for a real photo the site-wide fetch budget (avatar-budget.ts), so made-up paths never spend it.

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const VERSION_RE = /^[0-9a-f]{12}$/;
const MINUTE = 'public, max-age=60, s-maxage=60';

const notFound = () => new Response(null, { status: 404, headers: { 'cache-control': MINUTE } });

export async function GET(req: Request, { params }: { params: Promise<{ address: string; version: string }> }) {
  const { address, version } = await params;
  if (!ADDRESS_RE.test(address) || !VERSION_RE.test(version) || new URL(req.url).search !== '') return notFound();
  // Over this visitor's limit, or the store down: the letter avatar, before any database query.
  if (!(await reserveAvatarVisitor(visitorIp(req)))) return notFound();
  // The cheap indexed check first, so a made-up address costs no identity query.
  if (!(await registeredAddresses(db, [address], MONAD_TESTNET_ID)).has(address)) return notFound();
  const stored = (await resolveStoredIdentities(db, [address], MONAD_TESTNET_ID)).get(address)?.avatarUrl;
  // Only the current photo's path is served: an old version (a replaced photo) or a made-up one is a 404 with no fetch.
  if (!stored || version !== avatarVersion(stored)) return notFound();
  // A real photo: only now is the site-wide budget spent. Over it, or the store down: the letter avatar, no fetch.
  if (!(await reserveAvatarFetch())) return notFound();
  const photo = await fetch(stored);
  const type = photo.headers.get('content-type') ?? '';
  if (!photo.ok || !photo.body || !type.startsWith('image/')) return notFound();
  return new Response(photo.body, { headers: { 'content-type': type, 'cache-control': MINUTE, 'x-content-type-options': 'nosniff' } });
}
