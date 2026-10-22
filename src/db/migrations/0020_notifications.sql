-- Notifications, slice S1 (#214, .claude/design/NOTIFICATIONS_PLAN.md r8 §3.3). Additive only: older app code that
-- does not name these tables or the new column keeps working.
--   users.notification_prefs  per-kind switches; NULL = the defaults (src/lib/notifications/prefs.ts). Written only
--                             through prefsSet.
--   notifications             one row per user per thing (UNIQUE dedupe key); never holds user-written text.
--   notify_cursor             per contract, the highest block whose terminal events have been announced. The
--                             leaderboard re-sync runbook ("truncate both tables, re-run the seed", 0008) must NOT
--                             truncate it, and the prune never touches it: it is what keeps a re-seed silent.
--                             Written only by notifying scans (src/lib/leaderboard/indexer.ts).
--   mako_round_entrants       Rounds entrants seen by the notify scan; pruned after 9 days.
--   account_address_version   one row, raised by triggers on every write that adds, changes, moves or removes an
--                             account address (users.wallet_address, user_safes), from any app version (like 0017's
--                             trigger). A conflicting insert (ON CONFLICT DO NOTHING) fires none of them. Each notify
--                             batch that announces a result reads it first and checks it FOR SHARE as its last
--                             statement (plan §3.2 "Recipient history"). Never pruned.
--
-- Verification (after `pnpm db:migrate`):
--   SELECT id, version FROM account_address_version;      -- exactly one row
--   SELECT tgname FROM pg_trigger WHERE tgfoid = 'account_address_version_bump'::regproc ORDER BY 1;
--   -- user_safes_address_delete, user_safes_address_insert, user_safes_address_truncate, user_safes_address_update,
--   -- users_wallet_address_delete, users_wallet_address_insert, users_wallet_address_update
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notification_prefs" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind"        text        NOT NULL CHECK ("kind" IN ('claim','result','reply','closing','round_start','price')),
  "dedupe_key"  text        NOT NULL CHECK (octet_length("dedupe_key") BETWEEN 1 AND 200),
  "data"        jsonb       NOT NULL CHECK (octet_length("data"::text) <= 1024),
  "event_at"    timestamptz NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "read_at"     timestamptz,
  "email_id"    uuid,
  CONSTRAINT "notifications_user_dedupe" UNIQUE ("user_id", "dedupe_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_recent" ON "notifications" ("user_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_unread" ON "notifications" ("user_id") WHERE "read_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_created" ON "notifications" ("created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notify_cursor" (
  "chain_id"          integer     NOT NULL,
  "contract_address"  varchar(42) NOT NULL CHECK ("contract_address" = lower("contract_address")),
  "notified_through"  bigint      NOT NULL CHECK ("notified_through" >= 0),
  PRIMARY KEY ("chain_id", "contract_address")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mako_round_entrants" (
  "contract_address" varchar(42) NOT NULL CHECK ("contract_address" = lower("contract_address")),
  "round_id"         text        NOT NULL CHECK ("round_id" ~ '^[0-9]{1,78}$'),
  "account"          varchar(42) NOT NULL CHECK ("account" = lower("account")),
  "side"             smallint    NOT NULL CHECK ("side" IN (1, 2)),
  "block_number"     bigint      NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("contract_address", "round_id", "account")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_address_version" (
  "id"       boolean PRIMARY KEY DEFAULT true CHECK ("id"),
  "version"  bigint  NOT NULL
);--> statement-breakpoint
INSERT INTO "account_address_version" ("id", "version") VALUES (true, 0) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "account_address_version_bump"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "account_address_version" SET "version" = "version" + 1 WHERE "id";
  RETURN NULL;   -- AFTER triggers ignore the value; NULL also serves the statement-level truncate trigger
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_wallet_address_insert" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_wallet_address_insert" AFTER INSERT ON "users"
  FOR EACH ROW WHEN (NEW."wallet_address" IS NOT NULL)
  EXECUTE FUNCTION "account_address_version_bump"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_wallet_address_update" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_wallet_address_update" AFTER UPDATE OF "wallet_address", "id" ON "users"
  FOR EACH ROW WHEN (NEW."wallet_address" IS DISTINCT FROM OLD."wallet_address" OR NEW."id" IS DISTINCT FROM OLD."id")
  EXECUTE FUNCTION "account_address_version_bump"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_wallet_address_delete" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_wallet_address_delete" AFTER DELETE ON "users"
  FOR EACH ROW WHEN (OLD."wallet_address" IS NOT NULL)
  EXECUTE FUNCTION "account_address_version_bump"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "user_safes_address_insert" ON "user_safes";--> statement-breakpoint
CREATE TRIGGER "user_safes_address_insert" AFTER INSERT ON "user_safes"
  FOR EACH ROW EXECUTE FUNCTION "account_address_version_bump"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "user_safes_address_update" ON "user_safes";--> statement-breakpoint
CREATE TRIGGER "user_safes_address_update" AFTER UPDATE OF "safe_address", "chain_id", "user_id" ON "user_safes"
  FOR EACH ROW WHEN (NEW."safe_address" IS DISTINCT FROM OLD."safe_address" OR NEW."chain_id" IS DISTINCT FROM OLD."chain_id"
                     OR NEW."user_id" IS DISTINCT FROM OLD."user_id")
  EXECUTE FUNCTION "account_address_version_bump"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "user_safes_address_delete" ON "user_safes";--> statement-breakpoint
-- Fires for rows removed by ON DELETE CASCADE from a users delete too, so deleting an email account counts.
CREATE TRIGGER "user_safes_address_delete" AFTER DELETE ON "user_safes"
  FOR EACH ROW EXECUTE FUNCTION "account_address_version_bump"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "user_safes_address_truncate" ON "user_safes";--> statement-breakpoint
-- TRUNCATE fires no row trigger. TRUNCATE users must truncate user_safes in the same command, so this covers it.
CREATE TRIGGER "user_safes_address_truncate" AFTER TRUNCATE ON "user_safes"
  FOR EACH STATEMENT EXECUTE FUNCTION "account_address_version_bump"();
