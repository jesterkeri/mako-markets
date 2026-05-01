import { hexToBigInt, type Address, type Hex } from 'viem';

import { SUBMITTED_RESOLVER_MAX_AGE_MS } from '@/lib/aa-constants';
import { checkCronAuth, cronDiagnostics } from '@/lib/cron-auth';
import {
  AlreadyClaimedError,
  selectStaleSubmittedRows,
  transitionFromSubmitted,
} from '@/lib/aa-pending-user-ops';
import { resolveSubmittedOp } from '@/lib/user-op';

// ----------------------------------------------------------------------------
// GET /api/cron/aa-slow (every 5 minutes)
//
// Sweep `submitted` rows older than SUBMITTED_RESOLVER_MAX_AGE_MS. By that
// point the bundler has either landed the op or dropped it; resolveSubmittedOp
// distinguishes via on-chain receipt + nonce.
//
// Auth: Bearer-only. See cron-auth.ts.
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!checkCronAuth(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 403 });
  }
  const diagnostics = cronDiagnostics(req);

  const stale = await selectStaleSubmittedRows({
    thresholdMs: SUBMITTED_RESOLVER_MAX_AGE_MS,
    limit: 50,
  });
  let sentCount = 0;
  let revertedCount = 0;
  let expiredCount = 0;
  let ambiguousCount = 0;

  for (const row of stale) {
    if (!row.userOpHash) continue;
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
      await transitionFromSubmitted({ rowId: row.id, resolution });
      switch (resolution.kind) {
        case 'sent':
          sentCount++;
          break;
        case 'reverted':
          revertedCount++;
          break;
        case 'expired':
          expiredCount++;
          break;
        case 'ambiguous':
          ambiguousCount++;
          break;
      }
    } catch (e) {
      if (e instanceof AlreadyClaimedError) continue;
      console.error('[cron.aa-slow.resolve_failed]', { rowId: row.id, e });
    }
  }

  console.log(
    JSON.stringify({
      event: 'cron.aa-slow.run',
      processed: stale.length,
      sentCount,
      revertedCount,
      expiredCount,
      ambiguousCount,
      diagnostics,
    }),
  );

  return Response.json({
    ok: true,
    processed: stale.length,
    sentCount,
    revertedCount,
    expiredCount,
    ambiguousCount,
  });
}
