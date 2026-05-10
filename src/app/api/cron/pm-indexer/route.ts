import { createPublicClient, http } from 'viem';

import { db } from '@/db/client';
import { monadTestnet, MONAD_TESTNET_ID } from '@/lib/chain';
import { checkCronAuth, cronDiagnostics } from '@/lib/cron-auth';
import { runPmIndexerCron } from '@/lib/private-markets/cron';

// ----------------------------------------------------------------------------
// GET /api/cron/pm-indexer (every minute, fired by mako-auto-resolver
// CF Worker — see cf-worker/wrangler.toml)
//
// Runs runIndexerOnce against MakoPrivateMarketsV1 on Monad testnet.
// Mutex serialises overlapping ticks; busy short-circuit returns 200
// with status:'busy' (NOT a 5xx — busy is healthy).
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
  const deployBlockStr = process.env.NEXT_PUBLIC_PRIVATE_MARKETS_DEPLOY_BLOCK;
  if (!address || !deployBlockStr) {
    return Response.json(
      { error: 'pm-indexer-config-missing' },
      { status: 500 },
    );
  }

  const rpcUrl =
    process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  try {
    const { result, durationMs } = await runPmIndexerCron({
      db,
      publicClient,
      chainId: MONAD_TESTNET_ID,
      contractAddress: address as `0x${string}`,
      deployBlock: BigInt(deployBlockStr),
    });

    if (result.mutex === 'busy') {
      return Response.json({
        ok: true,
        status: 'busy',
        chainId: MONAD_TESTNET_ID,
        durationMs,
        diagnostics,
      });
    }

    return Response.json({
      ok: true,
      status: 'processed',
      chainId: result.chainId,
      mutex: result.mutex,
      fromBlock: result.fromBlock,
      toBlock: result.toBlock,
      decodedEventCount: result.decodedEventCount,
      marketsWritten: result.marketsWritten,
      releaseWarning: result.releaseWarning,
      durationMs,
      diagnostics,
    });
  } catch {
    // The error detail is already in structured logs via runPmIndexerCron.
    // Keep the response sanitized.
    return Response.json(
      { error: 'pm-indexer-cron-failed' },
      { status: 500 },
    );
  }
}
