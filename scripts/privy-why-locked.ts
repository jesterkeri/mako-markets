// ----------------------------------------------------------------------------
// scripts/privy-why-locked.ts
//
// Support and live-test diagnostic, READ-ONLY: for one email, read its Privy user (and its one embedded wallet's
// resource) with the app secret, and its recorded gate admission from the database, then print the gate's verdict
// (src/lib/privy-gate.ts) with the timestamps the order and export rules compare. The sign-in route refuses with a
// status only; this says which rule fired. It changes nothing in Privy or the database.
//
// Run in your own terminal (the secret and the database URL stay in .env.local, never printed):
//   corepack pnpm@10.32.1 exec tsx --env-file=.env.local scripts/privy-why-locked.ts <email>
// Prints the Privy user id, factor types and times, linked account types and wallet times, the wallet resource's
// export/import times and signer count, the admission, and the verdict. No email other than the one asked about, no
// secret, no connection string.
// ----------------------------------------------------------------------------

import { PrivyClient } from '@privy-io/node';
import postgres from 'postgres';

import { embeddedWallets, judgeFactors, judgePrivyUser, type EnrollmentCheckpoint, type GateAdmission, type GateUser, type GateWallet } from '../src/lib/privy-gate';

const iso = (sec: number | null | undefined) => (typeof sec === 'number' ? `${new Date(sec * 1000).toISOString()} (${sec})` : String(sec));
const isoMs = (ms: number | null | undefined) => (typeof ms === 'number' ? `${new Date(ms).toISOString()} (${ms} ms)` : String(ms));

async function main() {
  const email = process.argv[2]?.trim();
  if (!email || process.argv.length > 3) throw new Error('usage: privy-why-locked.ts <email>');
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!appId || !appSecret || !dbUrl) throw new Error('NEXT_PUBLIC_PRIVY_APP_ID, PRIVY_APP_SECRET and DATABASE_URL must be set');
  console.log(`privy app ${appId}, database host ${new URL(dbUrl).host}`);

  const client = new PrivyClient({ appId, appSecret });
  const user = (await client.users().getByEmailAddress({ address: email })) as unknown as GateUser;
  console.log(`privy user ${user.id}`);
  for (const m of user.mfa_methods) console.log(`  factor ${m.type}, verified ${iso(m.verified_at)}`);
  if (user.mfa_methods.length === 0) console.log('  no MFA factor');
  for (const a of user.linked_accounts) {
    if (a.type === 'wallet') {
      console.log(
        `  linked wallet ${a.chain_type ?? '?'} ${a.connector_type ?? '?'}/${a.wallet_client_type ?? '?'} id=${a.id ?? 'null'} ${a.address ?? ''}` +
          ` imported=${String(a.imported)} delegated=${String(a.delegated)} verified ${iso(a.verified_at)} first_verified ${iso(a.first_verified_at)}`,
      );
    } else {
      console.log(`  linked ${a.type}`);
    }
  }

  const embedded = embeddedWallets(user);
  let wallet: GateWallet | null = null;
  if (embedded.length === 1 && embedded[0].id) {
    const w = (await client.wallets().get(embedded[0].id)) as unknown as GateWallet & { additional_signers: unknown[] | null };
    wallet = { id: w.id, address: w.address, exported_at: w.exported_at ?? null, imported_at: w.imported_at ?? null, additional_signers: w.additional_signers ?? [] };
    console.log(`  wallet resource exported ${isoMs(wallet.exported_at)}, imported ${isoMs(wallet.imported_at)}, additional signers ${wallet.additional_signers.length}`);
  }

  const sql = postgres(dbUrl, { max: 1 });
  const rows = await sql<{ id: string; privy_totp_admitted_at: string | null; magic_eoa: string | null; privy_user_id: string | null }[]>`
    SELECT id, privy_totp_admitted_at, magic_eoa, privy_user_id FROM users WHERE privy_user_id = ${user.id} LIMIT 1`;
  // Checkpoints are bound to the browser that saw them (by the hash of its cookie secret), so this lists them all.
  const cp = await sql<{ totp_verified_at: string; recorded_at: Date; expires_at: Date }[]>`
    SELECT totp_verified_at, recorded_at, expires_at FROM privy_enrollment_checkpoints WHERE privy_user_id = ${user.id} ORDER BY recorded_at`;
  await sql.end();
  if (cp.length === 0) console.log('no enrollment checkpoint (no browser ever saw this user with an authenticator and no wallet)');
  for (const c of cp) console.log(`enrollment checkpoint: TOTP ${iso(Number(c.totp_verified_at))}, recorded ${c.recorded_at.toISOString()}, expires ${c.expires_at.toISOString()}`);
  // The verdict below assumes the browser holding the newest unexpired checkpoint is the one signing in.
  const live = cp.filter((c) => c.expires_at.getTime() > Date.now()).at(-1);
  const checkpoint: EnrollmentCheckpoint | null = live ? { totpVerifiedAt: Number(live.totp_verified_at) } : null;
  const row = rows[0];
  const admittedAt = row?.privy_totp_admitted_at == null ? null : Number(row.privy_totp_admitted_at);
  const admission: GateAdmission | null = row && admittedAt !== null && row.magic_eoa ? { wallet: row.magic_eoa.toLowerCase(), totpVerifiedAt: admittedAt } : null;
  console.log(row ? `mako account ${row.id}: admitted with TOTP ${iso(admittedAt)}, wallet ${row.magic_eoa ?? 'none'}` : 'no mako account bound to this privy user yet');

  const factors = judgeFactors(user);
  console.log(`factors: ${factors.ok ? `ok (TOTP ${iso(factors.totpVerifiedAt)})` : `${factors.status}: ${factors.reason}`}`);
  const v = judgePrivyUser(user, wallet, admission, admission ? null : checkpoint);
  console.log(v.ok ? `VERDICT ok: wallet ${v.wallet}` : `VERDICT ${v.status}: ${v.reason}`);
}

main().catch((err: unknown) => {
  // The error's name and, for a Privy API error, its status only: a message could echo a request.
  const status = (err as { status?: unknown } | null)?.status;
  console.error('privy-why-locked failed:', err instanceof Error ? err.name : 'unknown', typeof status === 'number' ? status : '');
  process.exit(2);
});
