-- Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29, sections 2.1 to 2.3; owner decisions Q-F to Q-I, Q-N).
-- A browser that completed a full sign-in (a Privy email code Mako saw at the moment it was entered, then the
-- authenticator) is remembered for 30 days; on it, signing in again needs only the authenticator.
--
-- email_ceremonies: one per email sign-in attempt, issued by POST /api/user/auth/email-start before the code is sent; it
--   names no account. Its secret lives only in the browser's httpOnly `mako_ec` cookie; the row keeps its SHA-256.
--   Step A (POST /api/user/auth/email-verified, right after Privy's loginWithCode) records the verification on it:
--   the token's Privy session id (hashed), the Privy user, and the email account's latest_verified_at (Unix seconds,
--   Privy's clock). It mints nothing. A bind spends it (used_at); the triggers marked "voids ceremonies" in the plan's
--   2.3 table void it (voided_at), and a voided ceremony is refused everywhere. attempts counts step-A calls, at most 10.
-- remembered_browsers: one Privy session (sid, hashed) bound to one browser (the `mako_rb` cookie's secret, hashed),
--   created only by a bind from a usable ceremony. Unique per (user_id, privy_sid_hash): a revoked or expired row
--   keeps that sid needing the email for good. factor_fingerprint is the Privy authenticator's verified_at (seconds)
--   at the bind; a different current value revokes every row of the account.
-- auth_challenges.rb_*: the legacy two-request path (Mako's own TOTP) carries the ceremony to spend or the row to use,
--   the session id hash and the authenticator fingerprint from /api/user/auth to /api/user/auth/totp.
-- users.privy_email_verified_seen: the largest latest_verified_at Mako has recorded for the account (seconds). Raised
--   only, never lowered: GREATEST at every session mint, and the conditional bind update (seen IS NULL OR seen < v).
--
-- Additive: older code that does not name these tables or columns keeps working. The feature itself stays off until
-- REMEMBERED_BROWSER_ENABLED is set.
--
-- Verification (after `pnpm db:migrate`):
--   \d email_ceremonies
--   \d remembered_browsers
--   \d auth_challenges   -- the four rb_ columns
--   \d users             -- privy_email_verified_seen
CREATE TABLE IF NOT EXISTS "email_ceremonies" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "secret_hash"             text NOT NULL,
  "created_at"              timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "verified_at"             timestamp with time zone,
  "verified_sid_hash"       text,
  "verified_privy_user_id"  text,
  "verified_value"          bigint,
  "used_at"                 timestamp with time zone,
  "voided_at"               timestamp with time zone,
  "attempts"                integer NOT NULL DEFAULT 0,
  CONSTRAINT "email_ceremonies_secret_hash_chk" CHECK ("secret_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "email_ceremonies_attempts_chk" CHECK ("attempts" BETWEEN 0 AND 10),
  -- Verified all at once or not at all. Each test is wrapped in COALESCE: a CHECK that evaluates to NULL passes.
  CONSTRAINT "email_ceremonies_verified_chk" CHECK (
    ("verified_at" IS NULL AND "verified_sid_hash" IS NULL AND "verified_privy_user_id" IS NULL AND "verified_value" IS NULL)
    OR ("verified_at" IS NOT NULL AND COALESCE("verified_sid_hash" ~ '^[0-9a-f]{64}$', false)
        AND COALESCE(length("verified_privy_user_id") BETWEEN 1 AND 200, false) AND COALESCE("verified_value" > 0, false))
  ),
  -- Only a verified ceremony can be spent.
  CONSTRAINT "email_ceremonies_used_chk" CHECK ("used_at" IS NULL OR "verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_ceremonies_secret_hash_uniq" ON "email_ceremonies" ("secret_hash");
--> statement-breakpoint
-- The voiding triggers look ceremonies up by Privy user: only verified, unspent, unvoided ones matter.
CREATE INDEX IF NOT EXISTS "email_ceremonies_pending_privy_idx" ON "email_ceremonies" ("verified_privy_user_id")
  WHERE "verified_at" IS NOT NULL AND "used_at" IS NULL AND "voided_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remembered_browsers" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "privy_sid_hash"      text NOT NULL,
  "device_secret_hash"  text NOT NULL,
  "ceremony_id"         uuid NOT NULL REFERENCES "email_ceremonies"("id"),
  "factor_fingerprint"  bigint NOT NULL,
  "created_at"          timestamp with time zone NOT NULL,
  "last_used_at"        timestamp with time zone,
  "expires_at"          timestamp with time zone NOT NULL,
  "revoked_at"          timestamp with time zone,
  "revoke_reason"       text,
  CONSTRAINT "remembered_browsers_sid_hash_chk" CHECK ("privy_sid_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "remembered_browsers_device_hash_chk" CHECK ("device_secret_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "remembered_browsers_fingerprint_chk" CHECK ("factor_fingerprint" > 0),
  CONSTRAINT "remembered_browsers_expiry_chk" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "remembered_browsers_revoked_chk" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)),
  CONSTRAINT "remembered_browsers_revoke_reason_chk" CHECK ("revoke_reason" IS NULL OR "revoke_reason" IN (
    'sign_out_everywhere', 'forget_browser', 'factor_changed', 'account_move', 'proof_failed', 'device_mismatch',
    'totp_lockout', 'email_changed'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "remembered_browsers_user_sid_uniq" ON "remembered_browsers" ("user_id", "privy_sid_hash");
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD COLUMN IF NOT EXISTS "rb_ceremony_id" uuid REFERENCES "email_ceremonies"("id");
ALTER TABLE "auth_challenges" ADD COLUMN IF NOT EXISTS "rb_row_id" uuid REFERENCES "remembered_browsers"("id") ON DELETE CASCADE;
ALTER TABLE "auth_challenges" ADD COLUMN IF NOT EXISTS "rb_sid_hash" text;
ALTER TABLE "auth_challenges" ADD COLUMN IF NOT EXISTS "rb_factor_fingerprint" bigint;
--> statement-breakpoint
-- A challenge names a ceremony to spend or a row to use, never both; the session id and fingerprint come with either.
DO $$ BEGIN
  ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_rb_chk" CHECK (
    ("rb_ceremony_id" IS NULL AND "rb_row_id" IS NULL AND "rb_sid_hash" IS NULL AND "rb_factor_fingerprint" IS NULL)
    OR ((("rb_ceremony_id" IS NULL) <> ("rb_row_id" IS NULL)) AND COALESCE("rb_sid_hash" ~ '^[0-9a-f]{64}$', false)
        AND COALESCE("rb_factor_fingerprint" > 0, false))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_challenges_user_idx" ON "auth_challenges" ("user_id");
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privy_email_verified_seen" bigint;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_privy_email_verified_seen_chk" CHECK ("privy_email_verified_seen" IS NULL OR "privy_email_verified_seen" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
