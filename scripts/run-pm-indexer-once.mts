// ----------------------------------------------------------------------------
// scripts/run-pm-indexer-once.mts
//
// Manual smoke runner for the Phase 2B-2 indexer. Loads .env.local,
// instantiates db + publicClient, calls runIndexerOnce, prints the
// summary JSON. The cron route in 2B-5 will be a thin Bearer-auth
// wrapper over the same call.
//
// Usage:
//   pnpm smoke:pm-indexer
//
// Env required:
//   DATABASE_URL or POSTGRES_URL
//   NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS
//   NEXT_PUBLIC_PRIVATE_MARKETS_DEPLOY_BLOCK
//   MONAD_RPC_URL (optional; falls back to public RPC)
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { createPublicClient, http } from 'viem';

import { monadTestnet, MONAD_TESTNET_ID } from '../src/lib/chain.js';
import { db } from '../src/db/client.js';
import { runIndexerOnce, isBusy } from '../src/lib/private-markets/indexer.js';

async function main() {
  const address = process.env.NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS;
  const deployBlockStr = process.env.NEXT_PUBLIC_PRIVATE_MARKETS_DEPLOY_BLOCK;
  if (!address || !deployBlockStr) {
    console.error(
      'Missing NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS or NEXT_PUBLIC_PRIVATE_MARKETS_DEPLOY_BLOCK in .env.local',
    );
    process.exit(1);
  }
  const deployBlock = BigInt(deployBlockStr);

  const rpcUrl = process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  console.log('================================================');
  console.log(' Phase 2B-2 indexer smoke run');
  console.log('================================================');
  console.log(' chainId      :', MONAD_TESTNET_ID);
  console.log(' contract     :', address);
  console.log(' deployBlock  :', deployBlock.toString());
  console.log(' rpc          :', rpcUrl);
  console.log('------------------------------------------------');

  const t0 = Date.now();
  const result = await runIndexerOnce({
    chainId: MONAD_TESTNET_ID,
    contractAddress: address as `0x${string}`,
    deployBlock,
    db,
    publicClient,
    chunkSize: process.env.MAKO_PM_INDEXER_CHUNK_SIZE
      ? Number(process.env.MAKO_PM_INDEXER_CHUNK_SIZE)
      : undefined,
    prefetchBatchSize: process.env.MAKO_PM_INDEXER_PREFETCH_BATCH
      ? Number(process.env.MAKO_PM_INDEXER_PREFETCH_BATCH)
      : undefined,
  });
  const elapsedMs = Date.now() - t0;

  if (isBusy(result)) {
    console.log(' mutex        : busy');
    console.log(' elapsedMs    :', elapsedMs);
  } else {
    console.log(' mutex        :', result.mutex);
    console.log(' fromBlock    :', result.fromBlock);
    console.log(' toBlock      :', result.toBlock);
    console.log(' decodedEvents:', result.decodedEventCount);
    console.log(' marketsWritten:', result.marketsWritten);
    console.log(' elapsedMs    :', elapsedMs);
  }
  console.log('================================================');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('run-pm-indexer-once failed:', err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  });
