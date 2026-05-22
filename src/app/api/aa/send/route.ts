import { hexToBigInt, type Address, type Hex } from 'viem';

import {
  SENDING_RECOVERY_THRESHOLD_MS,
  VALIDITY_WINDOW_MAX_UINT48,
} from '@/lib/aa-constants';
import { isSupportedAaChainId } from '@/lib/aa-config';
import {
  assertSponsoredCallData,
  NotAllowedError,
} from '@/lib/aa-call-allowlist';
import { summarizeAaErrorWithCause } from '@/lib/aa-errors';
import {
  AlreadyClaimedError,
  loadById,
  transitionPendingToExpired,
  transitionToFailedPreSubmit,
  transitionToReverted,
  transitionToSending,
  transitionToSent,
  transitionToSubmitted,
  transitionFromSubmitted,
  transitionFromSendingViaResolver,
  type LoadedRow,
} from '@/lib/aa-pending-user-ops';
import { SendRequest } from '@/lib/aa-route-schemas';
import { checkSameOrigin } from '@/lib/csrf';
import { getUserSession } from '@/lib/user-session';
import {
  resolveSubmittedOp,
  sendSignedUserOp,
  type SendOutcome,
} from '@/lib/user-op';

// ----------------------------------------------------------------------------
// POST /api/aa/send
//
// Validate the posted SafeOp signature against the persisted pending row,
// hand it to the bundler, settle the row's terminal state from the
// resulting `SendOutcome`. Branches on the row's current status — see
// plan v6 §"/api/aa/send flow (v2)" for the full state-machine table.
//
// `maxDuration = 120` covers the lib's 90s receipt poll plus DB I/O margin.
// Vercel Pro's default is 300s; we ask for less to fail predictably.
//
// Pre/post-callback split: the lib's internal order is sig-validation +
// drift guards (PRE-callback) → compute hash → fire callback → bundler
// send → receipt poll (all POST-callback). A `callbackFired` flag in the
// catch block decides whether a thrown error means the row stayed
// `pending` (return 400 SIG_VALIDATION) or moved to `sending` (return 500
// INTERNAL with rowStatus; the cron resolver settles via on-chain truth).
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/// Resolve the row's status into an outcome the route returns. Used both
/// at top of the switch and after AlreadyClaimedError reloads.
async function handleStatusBranch(args: {
  row: LoadedRow;
}): Promise<Response> {
  const { row } = args;
  switch (row.status) {
    case 'pending':
      // Caller must POST again to actually send — handleStatusBranch is
      // the post-reload helper, never called for a `pending` row by the
      // initial path. Treating it as 409 IN_FLIGHT is the correct race-
      // outcome surface (the caller can retry the full POST flow).
      return Response.json(
        {
          error: 'IN_FLIGHT',
          status: 'pending',
          retryAfterSeconds: 1,
        },
        { status: 409 },
      );

    case 'sending': {
      const ageMs = row.sendingStartedAt
        ? Date.now() - row.sendingStartedAt.getTime()
        : 0;
      if (ageMs < SENDING_RECOVERY_THRESHOLD_MS) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((SENDING_RECOVERY_THRESHOLD_MS - ageMs) / 1000),
        );
        return Response.json(
          { status: 'send_in_progress', retryAfterSeconds },
          { status: 202 },
        );
      }
      // Stale `sending` — fall through to the resolver.
      const resolved = await resolveSubmittedOp({
        chainId: row.chainId as 10143,
        safeAddress: row.safeAddress as Address,
        userOpHash: row.userOpHash as Hex,
        expectedNonce: hexToBigInt(row.nonceHex as Hex),
      });
      try {
        await transitionFromSendingViaResolver({
          rowId: row.id,
          resolution:
            resolved.final === 'safe_to_expire'
              ? { kind: 'expired' }
              : resolved.final === 'sent'
                ? { kind: 'sent', txHash: resolved.txHash }
                : resolved.final === 'reverted'
                  ? {
                      kind: 'reverted',
                      txHash: resolved.txHash,
                      failureReason: resolved.failureReason,
                    }
                  : { kind: 'ambiguous' },
        });
      } catch (e) {
        if (!(e instanceof AlreadyClaimedError)) throw e;
        // Cron resolver beat us; reload + recurse.
      }
      const fresh = await loadById({
        rowId: row.id,
        sessionUserId: row.userId,
      });
      if (!fresh) {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      return handleStatusBranch({ row: fresh });
    }

    case 'submitted': {
      const resolved = await resolveSubmittedOp({
        chainId: row.chainId as 10143,
        safeAddress: row.safeAddress as Address,
        userOpHash: row.userOpHash as Hex,
        expectedNonce: hexToBigInt(row.nonceHex as Hex),
      });
      try {
        await transitionFromSubmitted({
          rowId: row.id,
          resolution:
            resolved.final === 'safe_to_expire'
              ? { kind: 'expired' }
              : resolved.final === 'sent'
                ? { kind: 'sent', txHash: resolved.txHash }
                : resolved.final === 'reverted'
                  ? {
                      kind: 'reverted',
                      txHash: resolved.txHash,
                      failureReason: resolved.failureReason,
                    }
                  : { kind: 'ambiguous' },
        });
      } catch (e) {
        if (!(e instanceof AlreadyClaimedError)) throw e;
      }
      const fresh = await loadById({
        rowId: row.id,
        sessionUserId: row.userId,
      });
      if (!fresh) {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      return handleStatusBranch({ row: fresh });
    }

    case 'ambiguous':
      return Response.json(
        { status: 'manual_review' },
        { status: 423 },
      );

    case 'sent':
      return Response.json({
        status: 'sent',
        txHash: row.txHash,
        userOpHash: row.userOpHash,
      });

    case 'reverted':
      return Response.json({
        status: 'reverted',
        txHash: row.txHash,
        userOpHash: row.userOpHash,
        failureReason: row.failureReason,
      });

    case 'failed_pre_submit':
      return Response.json({
        status: 'failed_pre_submit',
        failureReason: row.failureReason,
      });

    case 'expired':
      return Response.json({ status: 'expired' }, { status: 410 });
  }
  // Unreachable thanks to the enum CHECK.
  return Response.json({ error: 'unknown_status' }, { status: 500 });
}

// PM feature-flag policy note (no logic here — comment-only):
// /api/aa/send is intentionally NOT gated by NEXT_PUBLIC_PM_ENABLED.
// SendRequest is { pendingUserOpId, signature } with no `kind` in
// the body, so a top-of-handler kind-gate is structurally
// impossible. The gate plan's locked decision #6 chose a drain
// policy instead: sponsor blocks NEW pm_* ops with 503, send lets
// already-validated pending rows complete. If a flag toggle ever
// leaves pm_* pending rows in flight, they drain to chain rather
// than orphaning the user's signature. See [[mako-pm-gate]] memory
// + /api/aa/sponsor/route.ts:195 for the symmetric gate.

export async function POST(req: Request) {
  // Step 0: same-origin gate (CSRF defense-in-depth).
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
  const parsed = SendRequest.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'bad_body', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { pendingUserOpId, signature } = parsed.data;

  // Step 3: load row gated on (id, sessionUserId) — cross-user reads miss.
  const row = await loadById({
    rowId: pendingUserOpId,
    sessionUserId: session.userId,
  });
  if (!row) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  // The row's chainId is trusted post-INSERT (CHECK constraints enforce
  // hex shapes), but we still gate the lib calls on the AA allowlist.
  if (!isSupportedAaChainId(row.chainId)) {
    return Response.json(
      { error: 'NOT_ALLOWED', reason: 'chain_unsupported' },
      { status: 400 },
    );
  }

  // Step 4: branch on row.status.
  switch (row.status) {
    case 'pending':
      // Fall through to the send flow below.
      break;
    case 'sending':
    case 'submitted':
    case 'ambiguous':
    case 'sent':
    case 'reverted':
    case 'failed_pre_submit':
    case 'expired':
      return handleStatusBranch({ row });
  }

  // Pending: must not be expired. Transition the row to `expired` here so
  // the partial unique index releases the slot immediately — otherwise the
  // sponsor route would keep returning a usable signing payload (via
  // serializeExistingInFlight) for an op that can never be sent, and a
  // misconfigured cron would leave the Safe blocked indefinitely.
  if (row.expiresAt.getTime() <= Date.now()) {
    const transition = await transitionPendingToExpired({
      rowId: row.id,
      sessionUserId: session.userId,
    });
    if (transition === 'already_claimed') {
      // Cron / another tab beat us. Reload + return whatever it decided.
      const fresh = await loadById({
        rowId: row.id,
        sessionUserId: session.userId,
      });
      if (!fresh) {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      return handleStatusBranch({ row: fresh });
    }
    return Response.json({ status: 'expired' }, { status: 410 });
  }

  // Defense-in-depth: re-validate the persisted userOp.callData against
  // the wrapper allowlist before signing. Sub-phase B's
  // `buildSponsoredUserOp` already produced a wrapper that the sponsor
  // route's `assertSponsorableCall` accepted, but the row has been at
  // rest in Postgres since then; this catches any tampering or schema
  // bug that might mutate the persisted callData.
  try {
    await assertSponsoredCallData({
      chainId: row.chainId,
      safeAddress: row.safeAddress as Address,
      callData: row.userOp.callData as Hex,
    });
  } catch (e) {
    if (e instanceof NotAllowedError) {
      console.error('[aa.send.callData_drift]', { rowId: row.id, reason: e.reason });
      return Response.json(
        { error: 'NOT_ALLOWED', reason: e.reason },
        { status: 403 },
      );
    }
    throw e;
  }

  // ── Send flow with pre/post-callback split ───────────────────────────
  let callbackFired = false;
  let outcome: SendOutcome;
  try {
    outcome = await sendSignedUserOp({
      chainId: row.chainId as 10143,
      userOp: row.userOp,
      signature: signature as Hex,
      expectedSafeOpHash: row.safeOpHash as Hex,
      expectedMagicEoa: row.magicEoa as Address,
      validAfter: 0n,
      validUntil: VALIDITY_WINDOW_MAX_UINT48,
      signatureScheme: 'eth_sign_envelope',
      onUserOpHashComputed: async (userOpHash) => {
        const result = await transitionToSending({
          rowId: row.id,
          sessionUserId: session.userId,
          userOpHash,
        });
        if (result === 'already_claimed') {
          // Aborts the lib BEFORE the bundler call. callbackFired stays
          // false because the row never actually transitioned for THIS
          // request.
          throw new AlreadyClaimedError(row.id);
        }
        callbackFired = true;
      },
    });
  } catch (e) {
    if (e instanceof AlreadyClaimedError) {
      // Concurrent /api/aa/send (or cron) moved the row. Reload + reroute.
      const fresh = await loadById({
        rowId: row.id,
        sessionUserId: session.userId,
      });
      if (!fresh) {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      return handleStatusBranch({ row: fresh });
    }

    if (!callbackFired) {
      // PRE-callback failure: signature length, validity window, drift
      // Guard A (SafeOp hash recompute), drift Guard B (signer recovery).
      // Row is still `pending` — user can re-sign.
      const summary = summarizeAaErrorWithCause(e);
      console.error('[aa.send.sig_validation]', summary);
      return Response.json(
        { error: 'SIG_VALIDATION', message: summary.message },
        { status: 400 },
      );
    }

    // POST-callback failure: bundler-vs-local userOpHash mismatch
    // (catastrophic — local hash math drifted from EntryPoint v0.7) OR
    // an unexpected JsonRpcReject from receipt poll. Row is `sending`;
    // do NOT transition from the route — the cron resolver settles via
    // on-chain truth once the row passes SENDING_RECOVERY_THRESHOLD_MS.
    const summary = summarizeAaErrorWithCause(e);
    console.error('[aa.send.post_callback]', summary);
    const fresh = await loadById({
      rowId: row.id,
      sessionUserId: session.userId,
    });
    return Response.json(
      {
        error: 'INTERNAL',
        message: summary.message,
        rowStatus: fresh?.status ?? 'unknown',
      },
      { status: 500 },
    );
  }

  // Map SendOutcome → DB UPDATE. Each is autocommit, gated on prior
  // status='sending'. AlreadyClaimedError on miss → reload + reroute.
  try {
    switch (outcome.outcome) {
      case 'sent':
        await transitionToSent({ rowId: row.id, txHash: outcome.txHash });
        return Response.json({
          status: 'sent',
          txHash: outcome.txHash,
          userOpHash: outcome.userOpHash,
        });
      case 'reverted':
        await transitionToReverted({
          rowId: row.id,
          txHash: outcome.txHash,
          failureReason: outcome.failureReason,
        });
        return Response.json({
          status: 'reverted',
          txHash: outcome.txHash,
          userOpHash: outcome.userOpHash,
          failureReason: outcome.failureReason,
        });
      case 'failed_pre_submit':
        await transitionToFailedPreSubmit({
          rowId: row.id,
          failureReason: outcome.failureReason,
        });
        return Response.json({
          status: 'failed_pre_submit',
          failureReason: outcome.failureReason,
        });
      case 'send_unknown':
      case 'submitted_unknown':
        await transitionToSubmitted({
          rowId: row.id,
          userOpHash: outcome.userOpHash,
        });
        return Response.json({
          status: 'submitted',
          userOpHash: outcome.userOpHash,
        });
    }
  } catch (e) {
    if (!(e instanceof AlreadyClaimedError)) throw e;
    // Cron resolver beat us. Reload + return whatever it decided.
    const fresh = await loadById({
      rowId: row.id,
      sessionUserId: session.userId,
    });
    if (!fresh) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    return handleStatusBranch({ row: fresh });
  }
  // Unreachable: the switch above covers every SendOutcome variant.
  return Response.json({ error: 'unknown_outcome' }, { status: 500 });
}
