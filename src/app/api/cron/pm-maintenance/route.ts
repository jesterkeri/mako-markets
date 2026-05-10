import { createPublicClient, http } from 'viem';

import { db } from '@/db/client';
import { monadTestnet, MONAD_TESTNET_ID } from '@/lib/chain';
import { checkCronAuth, cronDiagnostics } from '@/lib/cron-auth';
import { runPmMaintenanceCron } from '@/lib/private-markets/cron';

// ----------------------------------------------------------------------------
// GET /api/cron/pm-maintenance (every 5 minutes, fired by mako-auto-resolver
// CF Worker — see cf-worker/wrangler.toml)
//
// Two responsibilities:
//   1. Sweep stale pm_markets pending rows past TTL → 'failed'.
//   2. Resnapshot canonical metadata + reconcile pool_total / orphan-
//      resolution recovery.
//
// Sub-phases run independently — a failure in one does NOT block the
// other (Codex r2 m3).
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

  const address = process.env.NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS;
  if (!address) {
    return Response.json(
      { error: 'pm-maintenance-config-missing' },
      { status: 500 },
    );
  }

  const rpcUrl =
    process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  const result = await runPmMaintenanceCron({
    db,
    publicClient,
    chainId: MONAD_TESTNET_ID,
    contractAddress: address as `0x${string}`,
  });

  // Independent error paths: if either sub-phase threw, the helper
  // already logged it and surfaced the message in the result. Always
  // return 200 with the summary — the consumer (CF Worker scheduler)
  // doesn't need to retry, the next tick will pick up where this one
  // left off.
  return Response.json({
    ok: true,
    chainId: result.chainId,
    sweep: result.sweep,
    sweepError: result.sweepError,
    resnapshot: result.resnapshot,
    resnapshotError: result.resnapshotError,
    durationMs: result.durationMs,
    diagnostics,
  });
}
