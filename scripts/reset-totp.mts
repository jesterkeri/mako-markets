// One-shot dev helper: reset a user's TOTP state. Use after a smoke-pass
// lockout to get back to "2FA DISABLED, unlocked" without waiting out
// the 15-minute cooldown. Pass the email as an argument.
//
//   pnpm tsx scripts/reset-totp.mts your-email@example.com

import { config } from 'dotenv';
config({ path: '.env.development.local' });
config({ path: '.env.local' });
config({ path: '.env' });

import postgres from 'postgres';

const email = process.argv[2];
if (!email) {
  console.error('Usage: pnpm tsx scripts/reset-totp.mts <email>');
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) {
  console.error('No DATABASE_URL / POSTGRES_URL found.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

const result = await sql`
  UPDATE users
  SET totp_secret = NULL,
      totp_enabled_at = NULL,
      totp_failed_attempts = 0,
      totp_locked_until = NULL,
      totp_last_used_step = NULL
  WHERE email = ${email}
  RETURNING id, email, totp_secret IS NULL AS totp_disabled
`;

if (result.length === 0) {
  console.error(`No user found with email: ${email}`);
  process.exit(1);
}

console.log('Reset TOTP state for:', result[0]);
await sql.end();
