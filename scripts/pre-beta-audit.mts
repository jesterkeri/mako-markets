// ----------------------------------------------------------------------------
// scripts/pre-beta-audit.mts
//
// Release gate (INBOX_GAP_PLAN r18 [C1], [M4]), READ-ONLY: before the beta deploy, against the database and chain it
// is pointed at.
//   1. Every email account (auth_type 'magic', with or without a user_safes row) at the Safe its signer derives to,
//      and that Safe's USDC balance. A registry row that names another Safe blocks; a funded account with no registry
//      row blocks (Codex release-gates F2: the registry is not the authority for the address).
//   2. Accounts already linked to a Privy user: expected 0 in production before the first Privy deploy. Any with a
//      balance and no recorded gate admission (privy_totp_admitted_at) blocks the beta until enrolled or emptied.
//   3. Every FUNDED Safe's authority: exactly one owner (the account's signer), threshold 1, only the Safe4337 module,
//      no guard, the Safe4337 fallback handler, the v1.4.1 singleton. A Safe not deployed yet must at least be the
//      Safe its signer derives to. Any mismatch blocks the beta.
//   4. Funded Magic-era Safes, for the one-time "your old balance stays with your old login" email.
//
// Run in your own terminal (the database URL stays in your shell or .env.local; Claude never reads it):
//   corepack pnpm@10.32.1 exec tsx scripts/pre-beta-audit.mts
// Prints account ids, Safe addresses and verdicts; emails only with --emails (for the notice list). Exit 0 only when
// nothing blocks.
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { createPublicClient, erc20Abi, getAddress, http, parseAbi, type Address } from 'viem';

import { monadTestnet } from '../src/lib/chain.js';
import { deriveSafeAddress } from '../src/lib/safe.js';
import {
  judgeFundedAccount,
  judgeSafeAuthority,
  planEmailAccountAudit,
  SAFE_FALLBACK_SLOT,
  SAFE_GUARD_SLOT,
  type EmailAccountRow,
} from '../src/lib/safe-authority-audit.js';

loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const SAFE_ABI = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]);
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;

async function main() {
  const showEmails = process.argv.includes('--emails');
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const usdc = getAddress((process.env.NEXT_PUBLIC_USDC_ADDRESS_MONAD_TESTNET ?? '').trim());
  console.log(`pre-beta audit, database host ${new URL(url).host}, ${new Date().toISOString()}`);

  const sql = postgres(url, { max: 1 });
  // Every email account, LEFT JOINed: one with no registry row is still audited at its derived Safe.
  const rows = await sql<EmailAccountRow[]>`
    SELECT u.id, u.email, u.magic_eoa, u.privy_user_id, u.privy_totp_admitted_at, s.safe_address
    FROM users u LEFT JOIN user_safes s ON s.user_id = u.id AND s.chain_id = ${monadTestnet.id}
    WHERE u.auth_type = 'magic'`;
  await sql.end();

  const targets = planEmailAccountAudit(rows, (eoa) => deriveSafeAddress(getAddress(eoa)));
  const readable = targets.filter((t): t is typeof t & { safe: string } => t.safe !== null);
  const client = createPublicClient({ chain: monadTestnet, transport: http(process.env.MONAD_RPC_URL?.trim() || undefined, { retryCount: 1 }), batch: { multicall: true } });
  const balances = await client.multicall({
    allowFailure: false,
    contracts: readable.map((t) => ({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(t.safe)] }) as const),
  });

  const blockers: string[] = [];
  let privyLinked = 0;
  const magicFunded: string[] = [];
  const noSafe = targets.filter((t) => t.safe === null);
  for (const t of targets) for (const b of t.blockers) blockers.push(`${t.row.id}: ${b}`);
  for (const [i, t] of readable.entries()) {
    const r = t.row;
    const balance = balances[i] as bigint;
    const label = `${r.id} safe ${t.safe}${r.safe_address === null ? ' (no registry row)' : ''}`;
    if (r.privy_user_id) privyLinked += 1;
    const verdict = judgeFundedAccount(t, balance);
    for (const b of verdict.blockers) blockers.push(`${label}: ${b}`);
    if (verdict.magicFunded) magicFunded.push(showEmails && r.email ? `${label} ${r.email} (${balance})` : `${label} (${balance})`);
    if (balance === 0n) continue;

    const safe = getAddress(t.safe);
    const code = await client.getCode({ address: safe });
    if (!code || code === '0x') {
      // Not deployed: the Safe that will be deployed is the one its signer derives to.
      if (!t.derived || t.derived.toLowerCase() !== safe.toLowerCase()) {
        blockers.push(`${label}: funded, not deployed, and not the Safe its signer derives to`);
      }
      continue;
    }
    const [owners, threshold, page] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: safe, abi: SAFE_ABI, functionName: 'getOwners' },
        { address: safe, abi: SAFE_ABI, functionName: 'getThreshold' },
        { address: safe, abi: SAFE_ABI, functionName: 'getModulesPaginated', args: [SENTINEL, 10n] },
      ],
    });
    const [guardSlot, fallbackSlot, singletonSlot] = await Promise.all([
      client.getStorageAt({ address: safe, slot: SAFE_GUARD_SLOT }),
      client.getStorageAt({ address: safe, slot: SAFE_FALLBACK_SLOT }),
      client.getStorageAt({ address: safe, slot: '0x0' }),
    ]);
    // A storage read that returned nothing is not "no guard": block rather than assume (adversary on e1e0679).
    if (guardSlot === undefined || fallbackSlot === undefined || singletonSlot === undefined) {
      blockers.push(`${label}: a Safe storage read returned nothing; re-run`);
      continue;
    }
    const failures = judgeSafeAuthority(
      {
        owners: owners as readonly string[],
        threshold: threshold as bigint,
        modules: (page as readonly [readonly string[], string])[0],
        modulesNext: (page as readonly [readonly string[], string])[1],
        guardSlot,
        fallbackSlot,
        singletonSlot,
      },
      r.magic_eoa ?? '',
    );
    for (const f of failures) blockers.push(`${label}: ${f}`);
  }

  console.log(`email accounts: ${rows.length} (${rows.filter((r) => r.safe_address === null).length} with no user_safes row, audited at the derived Safe)`);
  console.log(`email accounts with no signer and no Safe (nothing to read): ${noSafe.length}`);
  for (const t of noSafe) {
    if (t.row.privy_user_id) privyLinked += 1;
    console.log(`  ${t.row.id}`);
  }
  console.log(`linked to a Privy user: ${privyLinked} (expected 0 in production before the first Privy deploy)`);
  console.log(`funded Magic-era Safes (notice email list): ${magicFunded.length}`);
  for (const m of magicFunded) console.log(`  ${m}`);
  for (const b of blockers) console.log(`BLOCK ${b}`);
  console.log(blockers.length === 0 ? 'PASS' : `BLOCKED (${blockers.length})`);
  process.exit(blockers.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  // The error's name only: a message could carry the database URL.
  console.error('pre-beta-audit failed:', err instanceof Error ? err.name : 'unknown');
  process.exit(2);
});
