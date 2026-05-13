import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Address } from 'viem';

import { db } from '@/db/client';
import { userSafes } from '@/db/schema';
import { getUserSession } from '@/lib/user-session';
import { allocatePmDraft } from '@/lib/private-markets/draft';
import { loadInFlightForSafe } from '@/lib/aa-pending-user-ops';
import { checkSameOrigin } from '@/lib/csrf';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';

// ----------------------------------------------------------------------------
// POST /api/pm/markets/draft (Phase 2C-1)
//
// Allocates a slug + inserts a pending pm_markets row. Called by the
// browser's runCreatePrivateMarket helper BEFORE building the
// createMarket userOp. The pending row holds only { chainId, contract,
// slug, clientNonce, creator, shape } — metadata fields stay at
// DEFAULT '' / 0 until the 2B-2 indexer hydrates them from view calls
// on MarketCreated.
//
// Auth: per-user session (getUserSession). The `creator` field
// stored = user_safes.safeAddress (mirrors /api/aa/sponsor's lookup
// pattern at route.ts:194-211). That same value gets compared against
// the decoded callData's clientNonce → row.creator at sponsor-time,
// so the two routes must agree on which address is "the user."
//
// Gating order (Codex 2C-1 r3 MAJ-1 + MAJ-2):
//   0. checkSameOrigin — CSRF gate before any state-touching work.
//      Mirrors /api/aa/sponsor + /api/aa/send + /api/user/auth.
//   1. session (cookie auth).
//   2. body parse + zod validation.
//   3. user_safes lookup for (userId, chainId) → safeAddress.
//   4. loadInFlightForSafe — reject 423 if the Safe has any in-flight
//      aa_pending_user_ops row. Mirrors /api/aa/sponsor's "PRECHECK
//      in-flight" step. Without this gate, double-submits leave stray
//      pending pm_markets rows that the stale-pending sweep later
//      recycles, but only after the slug is wasted and the partial
//      unique index has churned.
//   5. allocatePmDraft inside a transaction. The helper itself
//      enforces the per-Safe pending-draft cap
//      (PM_DRAFT_PENDING_CAP_PER_SAFE = 10) so the 11th pending row
//      is rejected with 429 BEFORE the slug allocation.
//
// On clientNonce collision: same 409 body for same-user AND
// cross-user duplicates (Codex r1 MIN-2, no info leak).
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RequestSchema = z
  .object({
    chainId: z.literal(MONAD_TESTNET_ID),
    contractAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .refine(
        (v) => v.toLowerCase() === PM_CONTRACT_ADDRESS.toLowerCase(),
        { message: 'contract_address_mismatch' },
      ),
    shape: z.enum(['friendly', 'open_vote', 'prize_pool']),
    clientNonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .strict();

export async function POST(req: Request) {
  // Step 0: same-origin gate (Codex 2C-1 r3 MAJ-1).
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  // Step 1: session.
  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Step 2: body + schema.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'bad_request', detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const { chainId, contractAddress, shape, clientNonce } = parsed.data;

  // Step 3: look up the user's safe address for this chain. Mirrors
  // the /api/aa/sponsor pattern so the `creator` field stored at
  // draft time matches the address that becomes msg.sender on chain.
  const safeRows = await db
    .select({ safeAddress: userSafes.safeAddress })
    .from(userSafes)
    .where(
      and(eq(userSafes.userId, session.userId), eq(userSafes.chainId, chainId)),
    )
    .limit(1);
  const userSafe = safeRows[0];
  if (!userSafe) {
    return Response.json({ error: 'no_user_safe' }, { status: 403 });
  }
  const sessionWallet = userSafe.safeAddress as `0x${string}`;

  // Step 4: in-flight gate (Codex 2C-1 r3 MAJ-2). Reject if the Safe
  // already has any aa_pending_user_ops row in flight. Without this,
  // a double-click from the dev surface or a stuck UI leaves a
  // never-progressing pm_markets row for the stale-pending sweep to
  // recycle later. With the gate, the user gets a clear 423 and we
  // never insert a stray draft row in the first place.
  const inFlight = await loadInFlightForSafe({
    chainId,
    safeAddress: sessionWallet as Address,
  });
  if (inFlight) {
    return Response.json(
      { error: 'aa_in_flight', status: inFlight.status },
      { status: 423 },
    );
  }

  // Step 5: allocate draft inside a transaction. The helper enforces
  // the per-Safe pending-draft cap (PM_DRAFT_PENDING_CAP_PER_SAFE)
  // BEFORE the slug allocation so a runaway client can't churn the
  // slug space.
  const result = await db.transaction((tx) =>
    allocatePmDraft({
      tx,
      sessionWallet,
      chainId,
      contractAddress: contractAddress as `0x${string}`,
      shape,
      clientNonce: clientNonce as `0x${string}`,
    }),
  );

  if (!result.ok) {
    if (result.error.kind === 'duplicate') {
      // Same body for same-user AND cross-user collisions (Codex r1
      // MIN-2: no existence-leak).
      return Response.json({ error: 'pm_draft_duplicate' }, { status: 409 });
    }
    if (result.error.kind === 'pending_cap') {
      return Response.json(
        { error: 'pm_draft_pending_cap', count: result.error.count },
        { status: 429 },
      );
    }
    return Response.json(
      { error: 'pm_draft_slug_exhausted' },
      { status: 500 },
    );
  }
  return Response.json(result.value);
}
