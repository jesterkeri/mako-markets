// ----------------------------------------------------------------------------
// scripts/resolve-ambiguous-op.mts
//
// Operator runbook script for resolving an `ambiguous` row in
// aa_pending_user_ops. Triggered when the cron resolver couldn't decide
// the row's terminal state (on-chain nonce advanced past expectedNonce
// but no receipt for our userOpHash — typically means a different op
// consumed the slot).
//
// Usage:
//   pnpm resolve:ambiguous <rowId>
//
// Script-safety:
//   This script runs OUTSIDE the Next.js server bundle (plain tsx). The
//   server-side AA modules (`src/lib/user-op.ts`, `src/lib/aa-rpc.ts`,
//   `src/lib/aa-config.ts`, `src/lib/aa-public-client.ts`) all carry
//   `import 'server-only'`, so this script must NOT runtime-import any
//   of them. Instead, it composes its own viem PublicClient + bundler
//   RPC the same way `scripts/probe-pimlico.mts` does — relative
//   imports of pure server-neutral modules (`safe-config`, `chain`)
//   only, and the resolver logic is reimplemented inline below.
//
// Flow:
//   1. Load the row (must be `ambiguous`).
//   2. Re-run resolveSubmittedOp + display its findings (receipt, on-chain
//      nonce, expected nonce, final classification).
//   3. Prompt the operator for resolution:
//        (1) sent     — provide tx_hash + operator note
//        (2) reverted — provide tx_hash + failure_reason
//        (3) expired
//        (4) leave as ambiguous
//        (5) abort
//   4. Status-gated UPDATE (still 'ambiguous' or no-op).
//   5. Emit single-line audit JSON to stdout AND append to
//      ./.local-ops/aa-pending-audit.log (gitignored).
//      Per-status sample shapes — `failureReason` ONLY appears on
//      `reverted`; `operatorNote` ONLY on `sent`; `expired` has neither.
//
// Operator MUST attach the JSON line to the incident ticket.
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createPublicClient,
  hexToBigInt,
  http,
  type Address,
  type Hex,
} from 'viem';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// src/ loads as CommonJS under tsx, and Node only GUESSES an ES module's named imports from CommonJS (some are
// missed: the pre-beta audit, 2026-10-07; Codex SIGNIN_R2 C1). require() always delivers every export; the
// type-only import keeps it checked. Guarded by src/lib/__tests__/scripts-esm-imports.test.ts.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import type * as SchemaModule from '../src/db/schema';
const { aaPendingUserOps } = require('../src/db/schema') as typeof SchemaModule;
import type * as SafeConfigModule from '../src/lib/safe-config';
const { SAFE_CONFIG } = require('../src/lib/safe-config') as typeof SafeConfigModule;
import type * as ChainModule from '../src/lib/chain';
const { MONAD_TESTNET_ID } = require('../src/lib/chain') as typeof ChainModule;

const SCRIPT_VERSION = '1.0.0';
const AUDIT_LOG_PATH = resolve(process.cwd(), '.local-ops/aa-pending-audit.log');

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const ENTRY_POINT_V07: Address = SAFE_CONFIG.entryPoint as Address;

// EntryPoint v0.7 — minimal ABI for the resolver's nonce read.
const ENTRY_POINT_ABI = [
  {
    name: 'getNonce',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key', type: 'uint192' },
    ],
    outputs: [{ name: 'nonce', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Script-local env access (no @/lib/aa-config.ts — that's server-only) ─────
function pimlicoUrlFor(chainId: number): string {
  const raw =
    chainId === MONAD_TESTNET_ID
      ? process.env.PIMLICO_API_KEY_MONAD || process.env.PIMLICO_API_KEY || ''
      : '';
  const key = raw.trim();
  if (!key) {
    throw new Error(
      `resolve-ambiguous: missing Pimlico key for chainId ${chainId} (PIMLICO_API_KEY_MONAD or PIMLICO_API_KEY)`,
    );
  }
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(key)}`;
}

function chainRpcUrl(chainId: number): string {
  if (chainId === MONAD_TESTNET_ID) {
    const url = process.env.MONAD_RPC_URL?.trim();
    if (!url) {
      throw new Error(
        'resolve-ambiguous: MONAD_RPC_URL must be set in .env.local for the on-chain nonce read',
      );
    }
    return url;
  }
  throw new Error(`resolve-ambiguous: unsupported chainId ${chainId}`);
}

// ── Inline resolver (mirrors src/lib/user-op.ts:resolveSubmittedOp) ──────────
type ResolverFinal =
  | { final: 'sent'; txHash: Hex }
  | { final: 'reverted'; txHash: Hex; failureReason: string }
  | { final: 'safe_to_expire' }
  | { final: 'ambiguous'; reason: string };

async function probeResolveSubmittedOp(args: {
  chainId: number;
  safeAddress: Address;
  userOpHash: Hex;
  expectedNonce: bigint;
}): Promise<ResolverFinal> {
  const bundlerUrl = pimlicoUrlFor(args.chainId);

  // 1. eth_getUserOperationReceipt — single round-trip, no polling
  //    (the script is interactive; if the receipt isn't there yet,
  //    the operator can re-run rather than block).
  const receiptResp = await fetch(bundlerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getUserOperationReceipt',
      params: [args.userOpHash],
    }),
  });
  if (!receiptResp.ok) {
    throw new Error(
      `resolve-ambiguous: bundler getUserOperationReceipt HTTP ${receiptResp.status}`,
    );
  }
  const receiptJson = (await receiptResp.json()) as {
    error?: { code: number; message: string };
    result?: {
      success: boolean;
      receipt: { transactionHash: Hex };
    } | null;
  };
  if (receiptJson.error) {
    throw new Error(
      `resolve-ambiguous: bundler error ${receiptJson.error.code} ${receiptJson.error.message}`,
    );
  }
  const receipt = receiptJson.result;
  if (receipt) {
    return receipt.success
      ? { final: 'sent', txHash: receipt.receipt.transactionHash }
      : {
          final: 'reverted',
          txHash: receipt.receipt.transactionHash,
          failureReason: 'on-chain revert',
        };
  }

  // 2. No receipt — check on-chain nonce against expectedNonce.
  const publicClient = createPublicClient({
    transport: http(chainRpcUrl(args.chainId)),
  });
  const onChainNonce = (await publicClient.readContract({
    address: ENTRY_POINT_V07,
    abi: ENTRY_POINT_ABI,
    functionName: 'getNonce',
    args: [args.safeAddress, 0n],
  })) as bigint;

  if (onChainNonce === args.expectedNonce) {
    return { final: 'safe_to_expire' };
  }
  if (onChainNonce > args.expectedNonce) {
    return {
      final: 'ambiguous',
      reason:
        `on-chain nonce ${onChainNonce} > expected ${args.expectedNonce} ` +
        `but no receipt for userOpHash=${args.userOpHash}`,
    };
  }
  return {
    final: 'ambiguous',
    reason:
      `on-chain nonce ${onChainNonce} < expected ${args.expectedNonce} ` +
      `(monotonicity violated — investigate RPC + Safe sender)`,
  };
}

async function main() {
  const rowId = process.argv[2];
  if (!rowId) {
    console.error('Usage: pnpm resolve:ambiguous <rowId>');
    process.exit(1);
  }

  const connectionString =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('No DATABASE_URL or POSTGRES_URL set; aborting.');
    process.exit(1);
  }
  const sql = postgres(connectionString, { prepare: false, max: 1 });
  const db = drizzle(sql, { schema: { aaPendingUserOps } });

  try {
    const rows = await db
      .select()
      .from(aaPendingUserOps)
      .where(
        and(
          eq(aaPendingUserOps.id, rowId),
          eq(aaPendingUserOps.status, 'ambiguous'),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      console.error(`row ${rowId} not found or not ambiguous; aborting.`);
      process.exit(1);
    }

    console.log('── Loaded row ──────────────────────────────────────────');
    console.log(`id              ${row.id}`);
    console.log(`user_id         ${row.userId}`);
    console.log(`chain_id        ${row.chainId}`);
    console.log(`safe_address    ${row.safeAddress}`);
    console.log(`status          ${row.status}`);
    console.log(`user_op_hash    ${row.userOpHash}`);
    console.log(`tx_hash         ${row.txHash ?? '(null)'}`);
    console.log(`expected nonce  ${row.nonceHex}`);

    if (!row.userOpHash) {
      console.error('row has no user_op_hash; cannot probe. aborting.');
      process.exit(1);
    }

    console.log('── Re-running resolveSubmittedOp (script-local) ────────');
    const probe = await probeResolveSubmittedOp({
      chainId: row.chainId,
      safeAddress: row.safeAddress as Address,
      userOpHash: row.userOpHash as Hex,
      expectedNonce: hexToBigInt(row.nonceHex as Hex),
    });
    console.log('probe.final =', probe.final);
    if (probe.final === 'sent' || probe.final === 'reverted') {
      console.log('probe.txHash =', probe.txHash);
    }
    if (probe.final === 'reverted') {
      console.log('probe.failureReason =', probe.failureReason);
    }
    if (probe.final === 'ambiguous') {
      console.log('probe.reason =', probe.reason);
    }

    const rl = createInterface({ input, output });
    console.log('── Resolve to ──────────────────────────────────────────');
    console.log('  (1) sent — provide tx_hash + operator note');
    console.log('  (2) reverted — provide tx_hash + failure_reason');
    console.log('  (3) expired');
    console.log('  (4) leave as ambiguous');
    console.log('  (5) abort');
    const choice = (await rl.question('Choice: ')).trim();

    let updated = false;
    let auditEvent: Record<string, unknown> | null = null;

    if (choice === '1') {
      const txHash = (await rl.question('tx_hash (0x…64): ')).trim();
      if (!HEX32.test(txHash)) {
        console.error('invalid tx_hash; aborting.');
        rl.close();
        process.exit(1);
      }
      const operatorNote = (await rl.question('operator note: ')).trim();
      if (!operatorNote) {
        console.error('operator note is required; aborting.');
        rl.close();
        process.exit(1);
      }
      const result = await db
        .update(aaPendingUserOps)
        .set({
          status: 'sent',
          txHash: txHash.toLowerCase() as Hex,
          statusUpdatedAt: new Date(),
        })
        .where(
          and(
            eq(aaPendingUserOps.id, row.id),
            eq(aaPendingUserOps.status, 'ambiguous'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      updated = result.length === 1;
      auditEvent = {
        event: 'aa_pending_user_op_audit',
        rowId: row.id,
        oldStatus: 'ambiguous',
        newStatus: 'sent',
        txHash: txHash.toLowerCase(),
        operatorNote,
        timestamp: new Date().toISOString(),
        scriptVersion: SCRIPT_VERSION,
      };
    } else if (choice === '2') {
      const txHash = (await rl.question('tx_hash (0x…64): ')).trim();
      if (!HEX32.test(txHash)) {
        console.error('invalid tx_hash; aborting.');
        rl.close();
        process.exit(1);
      }
      const failureReason = (
        await rl.question('failure_reason (required): ')
      ).trim();
      if (!failureReason) {
        console.error('failure_reason is required; aborting.');
        rl.close();
        process.exit(1);
      }
      const result = await db
        .update(aaPendingUserOps)
        .set({
          status: 'reverted',
          txHash: txHash.toLowerCase() as Hex,
          failureReason,
          statusUpdatedAt: new Date(),
        })
        .where(
          and(
            eq(aaPendingUserOps.id, row.id),
            eq(aaPendingUserOps.status, 'ambiguous'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      updated = result.length === 1;
      auditEvent = {
        event: 'aa_pending_user_op_audit',
        rowId: row.id,
        oldStatus: 'ambiguous',
        newStatus: 'reverted',
        txHash: txHash.toLowerCase(),
        failureReason,
        timestamp: new Date().toISOString(),
        scriptVersion: SCRIPT_VERSION,
      };
    } else if (choice === '3') {
      const result = await db
        .update(aaPendingUserOps)
        .set({ status: 'expired', statusUpdatedAt: new Date() })
        .where(
          and(
            eq(aaPendingUserOps.id, row.id),
            eq(aaPendingUserOps.status, 'ambiguous'),
          ),
        )
        .returning({ id: aaPendingUserOps.id });
      updated = result.length === 1;
      auditEvent = {
        event: 'aa_pending_user_op_audit',
        rowId: row.id,
        oldStatus: 'ambiguous',
        newStatus: 'expired',
        timestamp: new Date().toISOString(),
        scriptVersion: SCRIPT_VERSION,
      };
    } else if (choice === '4' || choice === '5') {
      console.log('no change; exiting.');
      rl.close();
      return;
    } else {
      console.error(`unknown choice "${choice}"; aborting.`);
      rl.close();
      process.exit(1);
    }
    rl.close();

    if (!updated) {
      console.error(
        'UPDATE matched 0 rows — row no longer ambiguous (cron or another ' +
          'operator may have transitioned it). No audit emitted.',
      );
      process.exit(1);
    }

    if (!auditEvent) {
      console.error('internal: no audit event generated; aborting.');
      process.exit(1);
    }

    const line = JSON.stringify(auditEvent) + '\n';
    console.log(line.trim());
    await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });
    await appendFile(AUDIT_LOG_PATH, line, { encoding: 'utf8' });
    console.log(`appended to ${AUDIT_LOG_PATH}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
