// ----------------------------------------------------------------------------
// scripts/seed-pm-indexer-cursor.mts
//
// One-shot dev helper: fast-forwards pm_indexer_state.last_indexed_block to
// (current Monad chain head - 5000) so the next smoke:pm-indexer run only
// scans ~5000 blocks instead of every block since deploy. Without this, the
// first run on a fresh local DB takes 4-6 minutes scanning ~800k blocks at
// Alchemy's 1000-block-per-call cap.
//
// Idempotent: if a row already exists with a higher last_indexed_block,
// keeps the higher value (never rewinds).
//
// Usage:  pnpm tsx scripts/seed-pm-indexer-cursor.mts
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { createPublicClient, http } from 'viem';
import postgres from 'postgres';

// src/ loads as CommonJS under tsx, and Node only GUESSES an ES module's named imports from CommonJS (some are
// missed: the pre-beta audit, 2026-10-07; Codex SIGNIN_R2 C1). require() always delivers every export; the
// type-only import keeps it checked. Guarded by src/lib/__tests__/scripts-esm-imports.test.ts.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import type * as ChainModule from '../src/lib/chain.js';
const { monadTestnet, MONAD_TESTNET_ID } = require('../src/lib/chain.js') as typeof ChainModule;
import { logResolvedTarget, requireDevStage } from './_smoke-guard.mjs';

const REWIND_BUFFER = 5_000n;

async function main() {
  requireDevStage('seed-pm-indexer-cursor');

  const address = process.env.NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS;
  if (!address) {
    console.error('Missing NEXT_PUBLIC_PRIVATE_MARKETS_ADDRESS in .env.local');
    process.exit(1);
  }
  const contractLower = address.toLowerCase();

  const connectionString =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('Missing DATABASE_URL or POSTGRES_URL in .env.local');
    process.exit(1);
  }

  const rpcUrl =
    process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];

  logResolvedTarget('seed-pm-indexer-cursor', {
    dbUrl: connectionString,
    contractAddress: address,
    rpcUrl,
  });
  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  const head = await publicClient.getBlockNumber();
  const target = head > REWIND_BUFFER ? head - REWIND_BUFFER : 0n;

  console.log(`chain head: ${head}`);
  console.log(`seeding pm_indexer_state.last_indexed_block = ${target}`);

  const sql = postgres(connectionString, { prepare: false });
  try {
    const rows = await sql`
      INSERT INTO pm_indexer_state (chain_id, contract_address, last_indexed_block, updated_at)
      VALUES (${MONAD_TESTNET_ID}, ${contractLower}, ${target.toString()}, now())
      ON CONFLICT (chain_id) DO UPDATE SET
        contract_address   = EXCLUDED.contract_address,
        last_indexed_block = GREATEST(pm_indexer_state.last_indexed_block, EXCLUDED.last_indexed_block),
        updated_at         = now()
      RETURNING chain_id, contract_address, last_indexed_block::text
    `;
    console.log('row after upsert:', rows[0]);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed-pm-indexer-cursor failed:', err?.message ?? err);
    if (err?.cause) {
      console.error('--- caused by ---');
      console.error(err.cause);
    }
    process.exit(1);
  });
