// ----------------------------------------------------------------------------
// scripts/run-pm-maintenance-once.mts
//
// Manual smoke runner for the Phase 2B-5 pm-maintenance cron. Invokes
// runPmMaintenanceCron once against the local DB + Monad testnet,
// covering both sub-phases:
//   1. sweepStalePending  — flips expired pending rows to 'failed'.
//   2. resnapshotConfirmed — hydrates title / description / streamUrl /
//      pool_total / timestamps on confirmed rows (the gap left after a
//      confirmed-flip path in the indexer).
//
// Mirrors scripts/run-pm-indexer-once.mts: same env loading, same
// inline postgres-js + Drizzle handle (bypasses src/db/client.ts to
// avoid `server-only` boundary in plain tsx).
//
// Usage:
//   pnpm tsx scripts/run-pm-maintenance-once.mts
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { createPublicClient, http } from 'viem';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { monadTestnet, MONAD_TESTNET_ID } from '../src/lib/chain.js';
import * as schema from '../src/db/schema.js';
import { runPmMaintenanceCron } from '../src/lib/private-markets/cron.js';

async function main() {
  const address = process.env.NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS;
  if (!address) {
    console.error('Missing NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS in .env.local');
    process.exit(1);
  }

  const connectionString =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('Missing DATABASE_URL or POSTGRES_URL in .env.local');
    process.exit(1);
  }
  const sql = postgres(connectionString, { prepare: false });
  const db = drizzle(sql, { schema });

  const rpcUrl =
    process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  console.log('================================================');
  console.log(' Phase 2B-5 pm-maintenance smoke run');
  console.log('================================================');
  console.log(' chainId   :', MONAD_TESTNET_ID);
  console.log(' contract  :', address);
  console.log(' rpc       :', rpcUrl);
  console.log('------------------------------------------------');

  let result;
  try {
    result = await runPmMaintenanceCron({
      db: db as never,
      publicClient,
      chainId: MONAD_TESTNET_ID,
      contractAddress: address as `0x${string}`,
      // For smoke we want a fresh resnapshot every run regardless of
      // last update — bypass the 30-minute decay default.
      resnapshotMaxAgeMs: 0,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log(' durationMs        :', result.durationMs);
  console.log(' sweep             :', JSON.stringify(result.sweep));
  if (result.sweepError) console.error(' sweepError        :', result.sweepError);
  console.log(' resnapshot        :', JSON.stringify(result.resnapshot));
  if (result.resnapshotError)
    console.error(' resnapshotError   :', result.resnapshotError);
  console.log('================================================');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('run-pm-maintenance-once failed:', err?.message ?? err);
    if (err?.cause) {
      console.error('--- caused by ---');
      console.error(err.cause);
    }
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  });
