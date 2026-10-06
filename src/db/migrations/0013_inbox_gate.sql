-- Inbox-takeover gate (mako-design INBOX_GAP_PLAN r18, 2026-10-06).
--
-- users.privy_totp_admitted_at: the authenticator verified_at (Unix seconds) an email account was first admitted with
--   under the gate ([G1]); NULL until its first gated sign-in. The wallet-after-authenticator order rule runs only then.
-- users.key_exported_at: the embedded wallet's exported_at as last seen at a sign-in ([F1], [G4]).
-- users.privy_email_mismatch_at / privy_email_observed: first detection of a Privy login email that differs from the
--   admitted one ([J3]); audit and support only, read by no allow-or-refuse path ([K10]). The observed email is
--   attacker-chosen input, so it is length-bounded here and never returned by a route.
-- privy_proof_nonces: the sign-in proof's single-use nonces (item 1, [B2]); issued before an account may exist, so
--   keyed by Privy user and wallet rather than a Mako user id.
--
-- Verification (after `pnpm db:migrate`):
--   \d users   -- the four columns
--   \d privy_proof_nonces
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privy_totp_admitted_at" bigint;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "key_exported_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privy_email_mismatch_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privy_email_observed" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_privy_totp_admitted_at_chk" CHECK ("privy_totp_admitted_at" IS NULL OR "privy_totp_admitted_at" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_privy_email_observed_len_chk" CHECK ("privy_email_observed" IS NULL OR length("privy_email_observed") <= 320);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "privy_proof_nonces" (
  "nonce"          text PRIMARY KEY,
  "privy_user_id"  text NOT NULL,
  "wallet"         text NOT NULL,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"     timestamp with time zone NOT NULL,
  "consumed_at"    timestamp with time zone,
  CONSTRAINT "privy_proof_nonces_nonce_chk" CHECK ("nonce" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "privy_proof_nonces_wallet_chk" CHECK ("wallet" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "privy_proof_nonces_expires_idx" ON "privy_proof_nonces" ("expires_at");
