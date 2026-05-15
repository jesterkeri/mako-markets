// ----------------------------------------------------------------------------
// scripts/run-pm-indexer-once.mts
//
// Manual smoke runner for the Phase 2B-2 indexer. Loads .env.local,
// instantiates a postgres-js + Drizzle handle inline, builds a viem
// PublicClient against Monad testnet, calls runIndexerOnce, prints
// the summary JSON. The cron route in 2B-5 will be a thin Bearer-auth
// wrapper over the same call.
//
// Codex round-2 M1: this script must NOT import `@/db/client` because
// that module starts with `import 'server-only'`, which in a plain
// `tsx` runtime resolves to a package whose default export throws.
// Next.js + Vitest both alias the package away at bundle time; plain
// `tsx` has no equivalent unless launched with
// `--conditions=react-server` (which the `smoke:pm-indexer` script
// now does — see package.json), and even then the indexer module
// chain pulls in db/client. So the smoke script builds its own DB
// handle here. `db/client.ts` stays unchanged so the production
// server runtime keeps the boundary check.
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
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { monadTestnet, MONAD_TESTNET_ID } from '../src/lib/chain.js';
import * as schema from '../src/db/schema.js';
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

  const connectionString =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('Missing DATABASE_URL or POSTGRES_URL in .env.local');
    process.exit(1);
  }
  // Inline Drizzle handle — see header comment for why this script
  // bypasses src/db/client.ts. Same postgres-js options the singleton
  // uses (`prepare: false`).
  const sql = postgres(connectionString, { prepare: false });
  const db = drizzle(sql, { schema });

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
  let result;
  try {
    result = await runIndexerOnce({
      chainId: MONAD_TESTNET_ID,
      contractAddress: address as `0x${string}`,
      deployBlock,
      // postgres-js Drizzle handle; runIndexerOnce only uses the
      // public Drizzle surface (no driver-specific calls), so the
      // structural typing matches the DbOrTx parameter at runtime.
      db: db as never,
      publicClient,
      chunkSize: process.env.MAKO_PM_INDEXER_CHUNK_SIZE
        ? Number(process.env.MAKO_PM_INDEXER_CHUNK_SIZE)
        : undefined,
      prefetchBatchSize: process.env.MAKO_PM_INDEXER_PREFETCH_BATCH
        ? Number(process.env.MAKO_PM_INDEXER_PREFETCH_BATCH)
        : undefined,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
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
    if (result.releaseWarning) {
      console.warn(
        ' releaseWarning:',
        result.releaseWarning,
        '\n   Lock may remain held until stale-recovery (5 min default).',
      );
    }
  }
  console.log('================================================');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('run-pm-indexer-once failed:', err?.message ?? err);
    // Drizzle wraps the postgres-js error; the real PG error (with
    // code, severity, hint) lives on .cause.
    if (err?.cause) {
      console.error('--- caused by ---');
      console.error(err.cause);
    }
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  });
