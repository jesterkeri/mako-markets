-- Phase 1G — display name + avatar URL + TOTP 2FA.
--
-- Adds seven identity/2FA columns to `users`:
--   - display_name           : nullable, server-validated [a-zA-Z0-9 ._-]{1,32}
--   - avatar_url             : nullable, https-only paste (no upload infra in 1G)
--   - totp_secret            : encrypted (AES-256-GCM) base32 secret; null = TOTP off
--   - totp_enabled_at        : timestamp set when verify-enrollment commits
--   - totp_failed_attempts   : atomic-incremented counter for sign-in lockout
--   - totp_locked_until      : non-null while a 15-min lockout is in flight
--   - totp_last_used_step    : last successfully-consumed TOTP step (replay guard)
--
-- Plus three new tables:
--   - recovery_codes              : bcrypt-hashed one-time codes (10 per user)
--   - pending_totp_enrollments    : server-stateful enrollment; encrypted secret
--                                   bound to pending-slot AAD; 10-min TTL
--   - auth_challenges             : pre-auth challenges issued by /api/user/auth
--                                   when totp_secret IS NOT NULL; consumed by
--                                   /api/user/auth/totp on successful factor
--                                   verification
--
-- Hard invariants enforced at the DB layer:
--   - Recovery codes per user use a partial index on (user_id) WHERE used_at
--     IS NULL so the unused-code lookup stays cheap as users accumulate
--     consumed codes over time.
--   - auth_challenges.purpose is a free-form text column (room for future
--     challenge purposes like webauthn) but routes pin the value.
--   - All FKs cascade on user delete — TOTP state shouldn't outlive the user.
--
-- Migration ordering: this file MUST be applied before deploying the new
-- routes that read these columns + tables, or Magic auth + email edit + the
-- TOTP enrollment flow will throw on the column reads.

ALTER TABLE "users"
  ADD COLUMN "display_name" text,
  ADD COLUMN "avatar_url" text,
  ADD COLUMN "totp_secret" text,
  ADD COLUMN "totp_enabled_at" timestamp with time zone,
  ADD COLUMN "totp_failed_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "totp_locked_until" timestamp with time zone,
  ADD COLUMN "totp_last_used_step" bigint;

CREATE TABLE "recovery_codes" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash"  text NOT NULL,
  "used_at"    timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "recovery_codes_user_unused_idx"
  ON "recovery_codes" ("user_id")
  WHERE "used_at" IS NULL;

CREATE TABLE "pending_totp_enrollments" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "encrypted_secret" text NOT NULL,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"       timestamp with time zone NOT NULL
);

CREATE INDEX "pending_totp_user_idx" ON "pending_totp_enrollments" ("user_id");
CREATE INDEX "pending_totp_expires_idx" ON "pending_totp_enrollments" ("expires_at");

CREATE TABLE "auth_challenges" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "magic_eoa"   text NOT NULL,
  "purpose"     text NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"  timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);

CREATE INDEX "auth_challenges_user_unconsumed_idx"
  ON "auth_challenges" ("user_id")
  WHERE "consumed_at" IS NULL;

CREATE INDEX "auth_challenges_expires_idx" ON "auth_challenges" ("expires_at");
