import { hexToBigInt, toHex, type Address, type Hex } from 'viem';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { userSafes, type AaPendingUserOp } from '@/db/schema';
import {
  PENDING_TTL_MS,
  VALIDITY_WINDOW_MAX_UINT48,
} from '@/lib/aa-constants';
import { isSupportedAaChainId } from '@/lib/aa-config';
import {
  assertBetBatchedCalls,
  assertBetSingleCall,
  assertCreateMarketCall,
  assertCreateMarketShape,
  assertSendUsdcCall,
  assertSponsorableCall,
  NotAllowedError,
} from '@/lib/aa-call-allowlist';
import { getAaPublicClient } from '@/lib/aa-public-client';
import { summarizeAaErrorWithCause } from '@/lib/aa-errors';
import {
  insertPending,
  loadInFlightForSafe,
} from '@/lib/aa-pending-user-ops';
import { SponsorRequest } from '@/lib/aa-route-schemas';
import {
  decrementForRefund,
  incrementOrReject,
} from '@/lib/aa-sponsor-limits';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { checkSameOrigin } from '@/lib/csrf';
import { isJsonRpcReject } from '@/lib/aa-rpc';
import { getUserSession } from '@/lib/user-session';
import { buildSponsoredUserOp } from '@/lib/user-op';
import { computeUserOpHash } from '@/lib/user-op-hash';
import { storedToPacked } from '@/lib/user-op-types';

// ----------------------------------------------------------------------------
// POST /api/aa/sponsor
//
// Build + persist a sponsored ERC-4337 user op. Returns the userOp + SafeOp
// hash + userOpHash so the browser can sign via Magic and post the result
// back to /api/aa/send.
//
// Steps (mirror plan v4 §"/api/aa/sponsor flow"):
//   0. checkSameOrigin (CSRF gate — same as /api/user/auth)
//   1. getUserSession → 401 if absent
//   2. zod-validate body via SponsorRequest discriminatedUnion('kind', […])
//   3. chainId allowlist (Monad testnet only)
//   4. user_safes lookup → 403 if absent
//   5. Validator dispatch on parsed.data.kind, all → 403 NOT_ALLOWED on mismatch:
//        smoke       → assertSponsorableCall  (USDC.transfer self 0n|1n)
//        bet_single  → assertBetSingleCall    (placeBet to MAKO)
//        bet_batched → assertBetBatchedCalls  (tuple [approve(MAKO, MaxUint256), placeBet(...)])
//   6. PRECHECK in-flight row; same-user own-pending → 200 with full
//      payload (`recovered: true`); cross-user OR non-pending → 409
//   7. Atomic aa_sponsor_limits increment; >cap → 429
//   8. buildSponsoredUserOp; arg shape mirrors the kind:
//        smoke / bet_single → { call }
//        bet_batched        → { calls }   (lib emits MultiSend wrapper)
//      PathXMismatchError → refund + 500;
//      JsonRpcReject → 503; transport → 502
//   9. INSERT aa_pending_user_ops ON CONFLICT DO NOTHING; race-loss →
//      refund + reload + serializeExistingInFlight
//  10. Return 200 with the freshly-built userOp + hash + expiresAt
//
// Same-origin enforcement is step 0 because every later step (session
// lookup, DB read, RPC call) costs more than rejecting a malicious cross-
// origin request up front.
//
// `Authorization: Bearer <session cookie>` is NOT used here — the existing
// app uses session cookies + same-origin for auth. The sponsor route
// inherits that. Postman/curl callers must include the cookie header.
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ServerError =
  | { status: number; body: Record<string, unknown> };

/// Detection stopgap: sub-phase B's `buildSponsoredUserOp` throws a plain
/// Error with the message prefix below on a Path X invariant violation. A
/// typed `PathXMismatchError` class is tracked as a sub-phase B follow-up;
/// when that ships, swap the regex for `instanceof`. See plan §Risks.
function isPathXMismatch(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /user-op:\s*safeAddress mismatch/i.test(e.message);
}

function mapBuildErrorToResponse(e: unknown): ServerError {
  const summary = summarizeAaErrorWithCause(e);
  if (isPathXMismatch(e)) {
    return {
      status: 500,
      body: { error: 'INTERNAL', message: summary.message },
    };
  }
  if (isJsonRpcReject(e)) {
    return {
      status: 503,
      body: { error: 'SPONSOR_UNAVAILABLE', message: summary.message },
    };
  }
  return {
    status: 502,
    body: { error: 'UPSTREAM', message: summary.message },
  };
}

/// Branches on (existing.userId, existing.status) to decide whether the
/// caller gets back the full signing payload (same-user own-pending —
/// dropped-response recovery) or just a minimal status snapshot.
/// Used by BOTH the precheck branch (step 6) and the INSERT race-loss
/// branch (step 9).
function serializeExistingInFlight(args: {
  existing: AaPendingUserOp;
  sessionUserId: string;
  chainId: number;
}): ServerError {
  const { existing, sessionUserId, chainId } = args;
  if (existing.userId === sessionUserId && existing.status === 'pending') {
    const userOpHash = computeUserOpHash({
      userOp: storedToPacked(existing.userOp),
      chainId,
    });
    return {
      status: 200,
      body: {
        pendingUserOpId: existing.id,
        userOp: existing.userOp,
        safeOpHash: existing.safeOpHash,
        userOpHash,
        validAfter: '0x0',
        validUntil: toHex(VALIDITY_WINDOW_MAX_UINT48),
        expiresAt: existing.expiresAt.toISOString(),
        recovered: true,
      },
    };
  }
  return {
    status: 409,
    body: {
      error: 'IN_FLIGHT',
      existing: {
        id: existing.id,
        status: existing.status,
        statusUpdatedAt: existing.statusUpdatedAt.toISOString(),
      },
    },
  };
}

export async function POST(req: Request) {
  // Step 0: same-origin gate.
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  // Step 1: session.
  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Step 2: zod-validate body.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const parsed = SponsorRequest.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'bad_body', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { chainId } = parsed.data;

  // Step 3: chainId allowlist. Same gate for every `kind`.
  if (!isSupportedAaChainId(chainId) || chainId !== MONAD_TESTNET_ID) {
    return Response.json(
      { error: 'NOT_ALLOWED', reason: 'chain_unsupported' },
      { status: 400 },
    );
  }

  // Step 4: user_safes lookup. Same gate for every `kind`.
  const safeRows = await db
    .select({ safeAddress: userSafes.safeAddress })
    .from(userSafes)
    .where(
      and(
        eq(userSafes.userId, session.userId),
        eq(userSafes.chainId, chainId),
      ),
    )
    .limit(1);
  const userSafe = safeRows[0];
  if (!userSafe) {
    return Response.json(
      { error: 'NOT_ALLOWED', reason: 'no_user_safe' },
      { status: 403 },
    );
  }
  const safeAddress = userSafe.safeAddress as Address;

  // Step 5: callData allowlist + per-kind builder args.
  //
  // Phase 1D Group 4: dispatch on `kind`. Each branch validates the
  // kind-specific shape and prepares the args for buildSponsoredUserOp.
  // The common middle (precheck / rate-limit / INSERT / conflict) is
  // shared below.
  type Call = { to: Address; value: bigint; data: Hex };
  let buildArgs:
    | { kind: 'smoke' | 'bet_single' | 'send_usdc' | 'create_market'; call: Call }
    | { kind: 'bet_batched'; calls: readonly [Call, Call] };
  try {
    switch (parsed.data.kind) {
      case 'smoke': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertSponsorableCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'smoke', call };
        break;
      }
      case 'bet_single': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertBetSingleCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'bet_single', call };
        break;
      }
      case 'bet_batched': {
        const [a, b] = parsed.data.calls;
        const calls: readonly [Call, Call] = [
          {
            to: a.to as Address,
            value: hexToBigInt(a.value as Hex),
            data: a.data as Hex,
          },
          {
            to: b.to as Address,
            value: hexToBigInt(b.value as Hex),
            data: b.data as Hex,
          },
        ];
        assertBetBatchedCalls({ chainId, safeAddress, calls });
        buildArgs = { kind: 'bet_batched', calls };
        break;
      }
      case 'send_usdc': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertSendUsdcCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'send_usdc', call };
        break;
      }
      case 'create_market': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Round-8 MINOR 1: cheap shape-only checks BEFORE the chain-
        // time RPC. Wrong target / wrong selector / bad mType / bad
        // question / immutable bettingCloseTime > closeTime all
        // reject without paying for a getBlock roundtrip. An authed
        // tester spamming malformed bodies cannot force chain-time
        // reads. Full validator below repeats these checks plus
        // the clock-relative invariants.
        assertCreateMarketShape({ chainId, safeAddress, call });

        // ONLY now do we pay the RPC cost for the latest chain block
        // timestamp. ONLY the create_market case incurs this; smoke /
        // bet_single / bet_batched / send_usdc are byte-for-byte
        // unchanged. Browser Date.now() is never trusted here.
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        assertCreateMarketCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
        });
        buildArgs = { kind: 'create_market', call };
        break;
      }
    }
  } catch (e) {
    if (e instanceof NotAllowedError) {
      // Round-8 MINOR 2: log `detail` for operators (when present) so
      // a NOT_ALLOWED rejection is debuggable beyond the stable reason
      // string. Response body intentionally omits detail — UI branches
      // on `reason` only and shouldn't see implementation specifics.
      console.warn('[aa.sponsor.not_allowed]', {
        reason: e.reason,
        detail: e.detail,
        userId: session.userId,
        chainId,
        kind: parsed.data.kind,
      });
      return Response.json(
        { error: 'NOT_ALLOWED', reason: e.reason },
        { status: 403 },
      );
    }
    throw e;
  }

  // Step 6: PRECHECK in-flight.
  const preExisting = await loadInFlightForSafe({ chainId, safeAddress });
  if (preExisting) {
    const result = serializeExistingInFlight({
      existing: preExisting,
      sessionUserId: session.userId,
      chainId,
    });
    return Response.json(result.body, { status: result.status });
  }

  // Step 7: atomic rate-limit increment.
  const limit = await incrementOrReject({
    userId: session.userId,
    chainId,
  });
  if (limit.kind === 'cap_exceeded') {
    return Response.json(
      { error: 'CAP_EXCEEDED', count: limit.count },
      { status: 429 },
    );
  }

  // Step 8: buildSponsoredUserOp. Branch on the discriminated buildArgs
  // so TypeScript's discriminated-union arg type narrows correctly.
  let built: Awaited<ReturnType<typeof buildSponsoredUserOp>>;
  try {
    if (buildArgs.kind === 'bet_batched') {
      built = await buildSponsoredUserOp({
        chainId,
        safeAddress,
        magicEoa: session.magicEoa as Address,
        calls: buildArgs.calls,
      });
    } else {
      built = await buildSponsoredUserOp({
        chainId,
        safeAddress,
        magicEoa: session.magicEoa as Address,
        call: buildArgs.call,
      });
    }
  } catch (e) {
    // Refund policy: PathXMismatch (pre-RPC code-side bug) refunds. All
    // Pimlico-side failures preserve the count (the user's attempt counted
    // against the local cap; Pimlico enforces dollar caps independently).
    if (isPathXMismatch(e)) {
      await decrementForRefund({ userId: session.userId, chainId });
    }
    const summary = summarizeAaErrorWithCause(e);
    console.error('[aa.sponsor.build_failed]', summary);
    const mapped = mapBuildErrorToResponse(e);
    return Response.json(mapped.body, { status: mapped.status });
  }

  // Step 9: INSERT pending row; partial unique index is the final
  // concurrency primitive.
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
  const inserted = await insertPending({
    userId: session.userId,
    chainId,
    safeAddress,
    magicEoa: session.magicEoa as Address,
    userOp: built.userOp,
    nonceHex: toHex(storedToPacked(built.userOp).nonce),
    safeOpHash: built.safeOpHash,
    expiresAt,
  });

  if (inserted.kind === 'conflict') {
    // Lost the partial-index race. Refund this caller's increment; the
    // Pimlico spend on `built` is unrecoverable but logged.
    await decrementForRefund({ userId: session.userId, chainId });
    console.warn('[aa.sponsor.race_lost]', {
      userId: session.userId,
      chainId,
      safeAddress,
      pimlicoSpendUnrecoverable: true,
    });

    const winner = await loadInFlightForSafe({ chainId, safeAddress });
    if (!winner) {
      // Edge case: the winner row got terminal between INSERT-conflict
      // and reload. Treat as transient — caller can retry.
      return Response.json(
        { error: 'IN_FLIGHT', message: 'in-flight row vanished mid-resolve' },
        { status: 409 },
      );
    }
    const result = serializeExistingInFlight({
      existing: winner,
      sessionUserId: session.userId,
      chainId,
    });
    return Response.json(result.body, { status: result.status });
  }

  // Step 10: success — return the freshly-built signing payload.
  return Response.json({
    pendingUserOpId: inserted.id,
    userOp: built.userOp,
    safeOpHash: built.safeOpHash,
    userOpHash: built.userOpHash,
    validAfter: '0x0',
    validUntil: toHex(VALIDITY_WINDOW_MAX_UINT48),
    expiresAt: inserted.expiresAt.toISOString(),
  });
}
