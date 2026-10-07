-- Enrollment checkpoint (owner decisions 2026-10-07). The live test found Privy re-stamps the authenticator's
-- verified_at about one second AFTER the wallet is created, so the r18 [C5]/[D2] rule comparing the two Privy
-- timestamps locked every new account. An adversary pass on the first checkpoint design then showed a checkpoint bound
-- only to the Privy user can be planted by an inbox-only attacker (own authenticator, record, remove it, create and
-- export the wallet), so each checkpoint is also bound to the BROWSER that saw it.
--
-- privy_enrollment_checkpoints: one row per browser that the server saw, from its own read of Privy with the app
--   secret, at a moment the Privy user had exactly one factor, an authenticator, and NO embedded wallet on any chain.
--   token_hash is the SHA-256 (hex) of a random secret the server set in that browser's httpOnly cookie; the secret
--   itself is never stored. A first admission requires a row for this Privy user whose hash matches the cookie of the
--   browser signing in, unexpired. Rows are only inserted, never updated. totp_verified_at is the authenticator's
--   verified_at (Unix seconds) as read then, before any wallet existed; it becomes the account's admission time.
--
-- Verification (after `pnpm db:migrate`):
--   \d privy_enrollment_checkpoints
CREATE TABLE IF NOT EXISTS "privy_enrollment_checkpoints" (
  "token_hash"        text PRIMARY KEY,
  "privy_user_id"     text NOT NULL,
  "totp_verified_at"  bigint NOT NULL,
  "recorded_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"        timestamp with time zone NOT NULL,
  CONSTRAINT "privy_enrollment_checkpoints_hash_chk" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "privy_enrollment_checkpoints_user_chk" CHECK (length("privy_user_id") BETWEEN 1 AND 200),
  CONSTRAINT "privy_enrollment_checkpoints_totp_chk" CHECK ("totp_verified_at" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "privy_enrollment_checkpoints_user_idx" ON "privy_enrollment_checkpoints" ("privy_user_id");
