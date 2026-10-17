import { db } from '@/db/client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { registeredAddresses, resolveStoredIdentities } from '@/lib/leaderboard/identity';
import { avatarVersion } from '@/lib/public-avatar';

// GET /api/avatar/<address>?v=<version> -> the account's profile photo, streamed.
// The public address of a photo (Joshua 2026-10-17, Codex PUBLIC_PROFILE R1 M2): the stored Blob URL's path carries
// the internal account id, so the leaderboard, profiles and comments link here instead. Streamed, never redirected (a
// redirect would hand out the stored URL). Only this app's own Blob store is fetched (resolveStoredIdentities keeps
// app-owned photos only), so this cannot be pointed at another host. Cached at most a minute, browser and CDN alike
// (Joshua 2026-10-17: a removed photo must stop being served, not linger in a year-long cache); `v` only makes a new
// photo show at once and is required: an old or made-up `v` is a 404. No account or no photo: 404 too, and the page
// shows the letter avatar.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MINUTE = 'public, max-age=60, s-maxage=60';

const notFound = () => new Response(null, { status: 404, headers: { 'cache-control': MINUTE } });

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  const raw = (await params).address;
  if (!ADDRESS_RE.test(raw)) return notFound();
  const address = raw.toLowerCase();
  // The cheap indexed check first, so a made-up address costs no identity query.
  if (!(await registeredAddresses(db, [address], MONAD_TESTNET_ID)).has(address)) return notFound();
  const stored = (await resolveStoredIdentities(db, [address], MONAD_TESTNET_ID)).get(address)?.avatarUrl;
  // Only the current photo's path is served: an old `v` (a replaced photo) or a made-up one is a 404 with no Blob fetch.
  if (!stored || new URL(req.url).searchParams.get('v') !== avatarVersion(stored)) return notFound();
  const photo = await fetch(stored);
  const type = photo.headers.get('content-type') ?? '';
  if (!photo.ok || !photo.body || !type.startsWith('image/')) return notFound();
  return new Response(photo.body, { headers: { 'content-type': type, 'cache-control': MINUTE, 'x-content-type-options': 'nosniff' } });
}
