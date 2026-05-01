import { type Address, type Hex } from 'viem';

import { hexToBigInt } from 'viem';

import { SENDING_RECOVERY_THRESHOLD_MS } from '@/lib/aa-constants';
import { checkCronAuth, cronDiagnostics } from '@/lib/cron-auth';
import {
  AlreadyClaimedError,
  expirePastDueRows,
  selectStaleSendingRows,
  transitionFromSendingViaResolver,
} from '@/lib/aa-pending-user-ops';
import { resolveSubmittedOp } from '@/lib/user-op';

// ----------------------------------------------------------------------------
// GET /api/cron/aa-fast (every minute)
//
// Two responsibilities:
//   1. Expire `pending` rows past their `expires_at` — frees the partial
//      unique index slot.
//   2. Recover stale `sending` rows (older than SENDING_RECOVERY_THRESHOLD_MS).
//      Calls resolveSubmittedOp + applies the resulting transition. The
//      lib's status-gate ensures we don't double-resolve a row that the
//      route resolved between the SELECT and the UPDATE.
//
// Auth: Bearer-only. See cron-auth.ts.
//
// LIMIT 50 keeps each invocation under Vercel's function budget while
// still draining typical workloads. Bump if beta sees the queue piling up.
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!checkCronAuth(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 403 });
  }
  const diagnostics = cronDiagnostics(req);

  // 1. Expire `pending` rows.
  const expiredCount = await expirePastDueRows();

  // 2. Recover stale `sending` rows.
  const staleSending = await selectStaleSendingRows({
    thresholdMs: SENDING_RECOVERY_THRESHOLD_MS,
    limit: 50,
  });
  let recoveredCount = 0;
  let ambiguousCount = 0;
  for (const row of staleSending) {
    if (!row.userOpHash) {
      // Constraint should prevent this, but skip rather than throw.
      continue;
    }
    try {
      const resolved = await resolveSubmittedOp({
        chainId: row.chainId as 10143,
        safeAddress: row.safeAddress as Address,
        userOpHash: row.userOpHash as Hex,
        expectedNonce: hexToBigInt(row.nonceHex as Hex),
      });
      const resolution =
        resolved.final === 'safe_to_expire'
          ? ({ kind: 'expired' } as const)
          : resolved.final === 'sent'
            ? ({ kind: 'sent', txHash: resolved.txHash } as const)
            : resolved.final === 'reverted'
              ? ({
                  kind: 'reverted',
                  txHash: resolved.txHash,
                  failureReason: resolved.failureReason,
                } as const)
              : ({ kind: 'ambiguous' } as const);
      await transitionFromSendingViaResolver({
        rowId: row.id,
        resolution,
      });
      if (resolution.kind === 'ambiguous') ambiguousCount++;
      else recoveredCount++;
    } catch (e) {
      if (e instanceof AlreadyClaimedError) {
        // Route or another cron run beat us — fine.
        continue;
      }
      console.error('[cron.aa-fast.recover_failed]', { rowId: row.id, e });
    }
  }

  console.log(
    JSON.stringify({
      event: 'cron.aa-fast.run',
      expiredCount,
      recoveredCount,
      ambiguousCount,
      processed: staleSending.length,
      diagnostics,
    }),
  );

  return Response.json({
    ok: true,
    expiredCount,
    recoveredCount,
    ambiguousCount,
  });
}
