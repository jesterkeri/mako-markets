-- Enrollment checkpoint (owner decision 2026-10-07, after the live test found Privy re-stamps the authenticator's
-- verified_at about one second AFTER the wallet is created, so the r18 [C5]/[D2] wallet-after-authenticator rule,
-- which compared the two Privy timestamps, locked every new account).
--
-- privy_enrollment_checkpoints: one row per Privy user, written ONLY by the server (/api/user/auth/proof) from its own
--   read of Privy with the app secret, at a moment that user had exactly one factor, an authenticator, and NO embedded
--   wallet on any chain. A first admission requires it: a wallet created by an inbox-only attacker before the owner
--   enrolled prevents the checkpoint from ever being written. Immutable: the first row wins (INSERT ... ON CONFLICT DO
--   NOTHING), nothing updates or deletes it. totp_verified_at is the authenticator's verified_at (Unix seconds) as
--   read then, before any wallet existed; it becomes the account's admission time.
--
-- Verification (after `pnpm db:migrate`):
--   \d privy_enrollment_checkpoints
CREATE TABLE IF NOT EXISTS "privy_enrollment_checkpoints" (
  "privy_user_id"     text PRIMARY KEY,
  "totp_verified_at"  bigint NOT NULL,
  "recorded_at"       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "privy_enrollment_checkpoints_user_chk" CHECK (length("privy_user_id") BETWEEN 1 AND 200),
  CONSTRAINT "privy_enrollment_checkpoints_totp_chk" CHECK ("totp_verified_at" > 0)
);
