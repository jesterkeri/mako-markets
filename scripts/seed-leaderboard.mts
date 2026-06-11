// ----------------------------------------------------------------------------
// scripts/seed-leaderboard.mts
//
// ONE-TIME cold-start backfill for the #186 leaderboard event ledger.
//
// Why this exists: the live v4 deploy block (32603678, 2026-05-18) is
// millions of sub-second Monad blocks behind head. No serverless cron
// tick can scan that — Vercel kills the function at maxDuration and the
// board sits empty/partial for the whole catch-up window. This script
// runs the same runLeaderboardIndexerOnce the cron uses, but in a local
// Node process with NO function timeout and NO time budget, looping
// until the cursor reaches head − CONFIRMATIONS.
//
// SHIP ORDER MATTERS (plan, Codex r2 MINOR-1): run this BEFORE
// `wrangler deploy` ships the cron ping. If the cron deploys first, a
// tick grabs the per-contract lock and the slow killed-and-resumed
// serverless path does the backfill instead of this fast uncontended
// script. If you see `busy` here, that's what happened — wait out the
// stale-lock window or check whether the cron is already live.
//
// Idempotent + resumable: each chunk commits events + cursor advance in
// one transaction against the (tx_hash, log_index) PK, so Ctrl+C and
// re-run is always safe.
//
// RPC note: the PUBLIC Monad RPC caps eth_getLogs at 100 blocks and
// rate-limits aggressively — a full backfill against it takes hours.
// Set MONAD_RPC_URL to a private endpoint (Alchemy/dRPC/Ankr) and bump
// LEADERBOARD_LOG_CHUNK (e.g. 1000) before running.
//
// Usage:
//   pnpm tsx scripts/seed-leaderboard.mts            # prints target, requires --yes
//   pnpm tsx scripts/seed-leaderboard.mts --yes      # actually runs
//
// Targets whatever DATABASE_URL/POSTGRES_URL points at — at ship time
// that is PROD. The --yes gate exists so a stray invocation can't start
// a multi-hour scan by accident.
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import process from 'node:process';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createPublicClient, http } from 'viem';

async function main() {
  // Modules imported AFTER dotenv so env-reading module scope
  // (contracts.ts deploy block, indexer chunk default) sees .env.local.
  // NOTE: @/db/client is deliberately NOT imported — it ships with
  // `import 'server-only'`, which throws outside Next (vitest stubs it,
  // tsx does not). The script builds its own postgres-js handle below,
  // same as the other operator scripts.
  const { monadTestnet, MONAD_TESTNET_ID } = await import('../src/lib/chain');
  const { runLeaderboardIndexerOnce, LEADERBOARD_CONFIRMATIONS } =
    await import('../src/lib/leaderboard/indexer');
  const { LEADERBOARD_CONTRACTS } = await import(
    '../src/lib/leaderboard/contracts'
  );
  const schema = await import('../src/db/schema');

  const dbUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!dbUrl) {
    console.error('Missing DATABASE_URL or POSTGRES_URL in env.');
    process.exit(1);
  }
  const sqlClient = postgres(dbUrl, { prepare: false });
  const db = drizzle(sqlClient, { schema });
  const rpcUrl =
    process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
  const usingPublicRpc = !process.env.MONAD_RPC_URL;

  // Redact credentials when echoing targets — DB URLs embed passwords,
  // private RPC URLs embed API keys in the path.
  const redactHost = (raw: string) => {
    try {
      return new URL(raw).host;
    } catch {
      return '<unparseable>';
    }
  };

  console.log('seed-leaderboard target:');
  console.log(`  db:        ${redactHost(dbUrl)}`);
  console.log(`  rpc:       ${redactHost(rpcUrl)}${usingPublicRpc ? '  (PUBLIC — slow, 100-block getLogs cap; set MONAD_RPC_URL)' : ''}`);
  console.log(`  chain:     ${MONAD_TESTNET_ID}`);
  console.log(`  contracts: ${LEADERBOARD_CONTRACTS.map((c) => `${c.address} from block ${c.deployBlock}`).join(', ')}`);
  console.log(`  horizon:   head - ${LEADERBOARD_CONFIRMATIONS} confirmations`);

  if (!process.argv.includes('--yes')) {
    console.log('\nDry preview only. Re-run with --yes to start the backfill.');
    process.exit(0);
  }

  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  const startedAt = Date.now();
  let totalInserted = 0;
  let pass = 0;
  const MAX_PASSES = 10;

  // Each runLeaderboardIndexerOnce call scans to (head-at-entry − 16);
  // the head moves during a long pass, so loop until a pass reports
  // upToDate for every contract. Typically 2 passes: the long one, then
  // a short top-up.
  for (;;) {
    pass += 1;
    if (pass > MAX_PASSES) {
      console.error(
        `Not up to date after ${MAX_PASSES} passes — head is outrunning the scan. ` +
          'Use a faster RPC (MONAD_RPC_URL) / larger LEADERBOARD_LOG_CHUNK.',
      );
      process.exit(1);
    }

    console.log(`\npass ${pass}…`);
    const result = await runLeaderboardIndexerOnce({
      db,
      publicClient,
      chainId: MONAD_TESTNET_ID,
      // No timeBudgetMs: local Node has no serverless timeout.
      onChunk: ({ contractAddress, chunkEnd, scanTarget, rowsInChunk }) => {
        const remaining = scanTarget - chunkEnd;
        if (rowsInChunk > 0 || remaining % 50_000 < 1_000) {
          console.log(
            `  ${contractAddress.slice(0, 10)}… block ${chunkEnd} / ${scanTarget} (${remaining} left)${rowsInChunk > 0 ? ` +${rowsInChunk} events` : ''}`,
          );
        }
      },
    });

    let allUpToDate = true;
    for (const c of result.contracts) {
      totalInserted += c.eventsInserted;
      if (c.mutex === 'busy') {
        console.error(
          `  ${c.contractAddress}: BUSY — another worker holds the lock. ` +
            'Is the cron already deployed? Seed must run before wrangler deploy.',
        );
        process.exit(1);
      }
      console.log(
        `  ${c.contractAddress}: scanned to ${c.scannedTo} (target ${c.scanTarget}), +${c.eventsInserted} events${c.upToDate ? ' — up to date' : ''}`,
      );
      if (!c.upToDate) allUpToDate = false;
      if (c.releaseWarning) console.warn(`  WARN: ${c.releaseWarning}`);
    }
    if (allUpToDate) break;
  }

  const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(
    `\nseed complete: ${totalInserted} events ingested across ${pass} pass(es) in ${mins} min.`,
  );
  console.log(
    'Next: wrangler deploy the cf-worker so the 5-min cron keeps the cursor warm.',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('seed-leaderboard failed:', err);
  process.exit(1);
});
