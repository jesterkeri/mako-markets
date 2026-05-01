-- Phase 1B sub-phase C: ERC-4337 user-op state machine + Pimlico sponsor
-- rate-limit table.
--
-- This migration is hand-written (NOT `pnpm db:generate` output) so the
-- partial unique index `WHERE` clause and the four CHECK constraints land
-- byte-exactly. Drizzle's generator has been observed to rewrite multi-OR
-- predicates in subtle ways across versions; the source-of-truth SQL lives
-- here and `src/db/schema.ts` mirrors the column shape (constraint
-- enforcement is DB-layer).
--
-- Verification: after `pnpm db:migrate`, run:
--   SELECT pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conname LIKE 'aa_pending_%';
-- Each definition should match the SQL written below.

CREATE TYPE "public"."aa_pending_status" AS ENUM(
  'pending', 'sending', 'submitted',
  'sent', 'reverted', 'failed_pre_submit', 'expired', 'ambiguous'
);--> statement-breakpoint
CREATE TABLE "aa_pending_user_ops" (
  "id"                    uuid          PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"               uuid          NOT NULL,
  "chain_id"              integer       NOT NULL,
  "safe_address"          varchar(42)   NOT NULL,
  "magic_eoa"             varchar(42)   NOT NULL,
  "user_op"               jsonb         NOT NULL,
  "nonce_hex"             varchar(66)   NOT NULL,
  "safe_op_hash"          varchar(66)   NOT NULL,
  "status"                "aa_pending_status" DEFAULT 'pending' NOT NULL,
  "user_op_hash"          varchar(66),
  "tx_hash"               varchar(66),
  "failure_reason"        text,
  "created_at"            timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at"            timestamp with time zone NOT NULL,
  "sending_started_at"    timestamp with time zone,
  "status_updated_at"     timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "aa_pending_safe_address_lower" CHECK (
    "safe_address" ~* '^0x[0-9a-f]{40}$' AND "safe_address" = lower("safe_address")
  ),
  CONSTRAINT "aa_pending_magic_eoa_lower" CHECK (
    "magic_eoa" ~* '^0x[0-9a-f]{40}$' AND "magic_eoa" = lower("magic_eoa")
  ),
  CONSTRAINT "aa_pending_nonce_hex_lower" CHECK (
    "nonce_hex" ~* '^0x[0-9a-f]+$' AND "nonce_hex" = lower("nonce_hex")
  ),
  CONSTRAINT "aa_pending_safe_op_hash_lower" CHECK (
    "safe_op_hash" ~* '^0x[0-9a-f]{64}$' AND "safe_op_hash" = lower("safe_op_hash")
  ),
  CONSTRAINT "aa_pending_user_op_hash_lower" CHECK (
    "user_op_hash" IS NULL
    OR ("user_op_hash" ~* '^0x[0-9a-f]{64}$' AND "user_op_hash" = lower("user_op_hash"))
  ),
  CONSTRAINT "aa_pending_tx_hash_lower" CHECK (
    "tx_hash" IS NULL
    OR ("tx_hash" ~* '^0x[0-9a-f]{64}$' AND "tx_hash" = lower("tx_hash"))
  ),
  CONSTRAINT "aa_pending_sending_requires_metadata" CHECK (
    "status" != 'sending'
    OR ("sending_started_at" IS NOT NULL AND "user_op_hash" IS NOT NULL)
  ),
  CONSTRAINT "aa_pending_post_send_requires_user_op_hash" CHECK (
    "status" NOT IN ('submitted', 'ambiguous', 'sent', 'reverted')
    OR "user_op_hash" IS NOT NULL
  ),
  CONSTRAINT "aa_pending_terminal_chain_requires_tx_hash" CHECK (
    "status" NOT IN ('sent', 'reverted')
    OR "tx_hash" IS NOT NULL
  ),
  CONSTRAINT "aa_pending_failed_requires_reason" CHECK (
    "status" NOT IN ('failed_pre_submit', 'reverted')
    OR "failure_reason" IS NOT NULL
  )
);--> statement-breakpoint
ALTER TABLE "aa_pending_user_ops"
  ADD CONSTRAINT "aa_pending_user_ops_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aa_pending_one_in_flight"
  ON "aa_pending_user_ops" USING btree ("chain_id", "safe_address")
  WHERE "status" IN ('pending', 'sending', 'submitted', 'ambiguous');--> statement-breakpoint
CREATE INDEX "aa_pending_user_id"
  ON "aa_pending_user_ops" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "aa_pending_pending_expires"
  ON "aa_pending_user_ops" USING btree ("expires_at")
  WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "aa_pending_sending_started"
  ON "aa_pending_user_ops" USING btree ("sending_started_at")
  WHERE "status" = 'sending';--> statement-breakpoint
CREATE INDEX "aa_pending_submitted_age"
  ON "aa_pending_user_ops" USING btree ("status_updated_at")
  WHERE "status" = 'submitted';--> statement-breakpoint
CREATE INDEX "aa_pending_ambiguous_age"
  ON "aa_pending_user_ops" USING btree ("status_updated_at")
  WHERE "status" = 'ambiguous';--> statement-breakpoint
CREATE TABLE "aa_sponsor_limits" (
  "user_id"  uuid    NOT NULL,
  "chain_id" integer NOT NULL,
  "day"      date    NOT NULL,
  "count"    integer DEFAULT 0 NOT NULL,
  CONSTRAINT "aa_sponsor_limits_user_id_chain_id_day_pk"
    PRIMARY KEY ("user_id", "chain_id", "day"),
  CONSTRAINT "aa_sponsor_limits_nonneg" CHECK ("count" >= 0)
);--> statement-breakpoint
ALTER TABLE "aa_sponsor_limits"
  ADD CONSTRAINT "aa_sponsor_limits_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aa_sponsor_limits_day"
  ON "aa_sponsor_limits" USING btree ("day");
