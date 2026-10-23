import { db } from '@/db/client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { referralCounts } from '@/lib/competition/referrals';
import { resolvePmActorAddress } from '@/lib/private-markets/actor';
import { referralCode } from '@/lib/ref-tag';
import { getUserSession } from '@/lib/user-session';

// GET /api/user/referrals -> { joined, qualified, canAddInviter }
//
// The signed-in caller's own referral progress for the Me card (REFERRAL_COMPETITION_PLAN slice 2): how many accounts
// signed up with the caller's link or code, and how many of those placed a bet (what counts toward entering). Counts
// only, never who. canAddInviter: whether the caller may still enter a friend's code (POST /api/user/referrer).
// The code comes from the session's own account address (the Safe for email accounts, the wallet for wallet accounts),
// never from the request.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getUserSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const actor = await resolvePmActorAddress(session, MONAD_TESTNET_ID);
  // An email account without its Safe yet has no link to share, so nobody can have used it.
  if (!actor.ok) return Response.json({ joined: 0, qualified: 0, canAddInviter: false });
  return Response.json(await referralCounts(db, session.userId, referralCode(actor.address)));
}
