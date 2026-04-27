import { type Address } from 'viem';

import { deriveSafeAddress } from '@/lib/safe';
import { getUserSession } from '@/lib/user-session';

// ----------------------------------------------------------------------------
// GET /api/user/me
//
// Returns the authenticated user's identity and their derived Safe address
// (Path X — same value on every chain). Returns { authed: false } when the
// session is missing, expired, or revoked. Never throws on auth failure;
// `getUserSession` already returns null for the common failure modes.
//
// Safe address is recomputed from the stored EOA on every call rather than
// read from `user_safes`. The derivation is pure (CREATE2, no RPC) and the
// stored row is just a cache for joinable queries — recomputing here keeps
// this route free of DB joins while still returning the correct value.
// ----------------------------------------------------------------------------

export async function GET() {
  const session = await getUserSession();
  if (!session) {
    return Response.json({ authed: false });
  }

  const safeAddress = deriveSafeAddress(session.magicEoa as Address);

  return Response.json({
    authed: true,
    email: session.email,
    magicEoa: session.magicEoa,
    safeAddress,
  });
}
