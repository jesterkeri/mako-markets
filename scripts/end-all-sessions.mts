// ----------------------------------------------------------------------------
// scripts/end-all-sessions.mts
//
// Release gate and rollback step (INBOX_GAP_PLAN r18 item 2): end every Mako Market session, so no session minted by
// an older build (before the inbox-takeover gate) outlives the deploy. Run AFTER the new build serves every request,
// and again an hour later (an old instance may still have been serving during the rollout). Also the rollback step:
// after rolling the site back, run it so no session from the rolled-back build survives.
//
// Sessions are database rows (src/lib/user-session.ts); deleting them signs everyone out. Accounts, Safes and funds
// are untouched. Nothing happens without --confirm.
//
//   corepack pnpm@10.32.1 exec tsx scripts/end-all-sessions.mts            (counts only)
//   corepack pnpm@10.32.1 exec tsx scripts/end-all-sessions.mts --confirm  (deletes, prints the count)
// The database URL stays in your shell or .env.local; Claude never reads it.
// ----------------------------------------------------------------------------

import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

loadEnv({ path: '.env.development.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const confirm = process.argv.includes('--confirm');
  const sql = postgres(url, { max: 1 });
  try {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions`;
    console.log(`database host ${new URL(url).host}, ${new Date().toISOString()}: ${n} sessions`);
    if (!confirm) {
      console.log('counted only; run again with --confirm to end them all');
      return;
    }
    const deleted = await sql`DELETE FROM sessions`;
    console.log(`ended ${deleted.count} sessions`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  // The error's name only: a message could carry the database URL.
  console.error('end-all-sessions failed:', err instanceof Error ? err.name : 'unknown');
  process.exit(2);
});
