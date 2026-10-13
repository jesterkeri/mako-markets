-- SafeOp validity window on each sponsored op (Codex CREATOR_EARNINGS R4, 2026-10-13). The window is part of the
-- SafeOp hash the user signs, so the sponsor response, a recovered pending response and the send route must all
-- carry the window the op was BUILT with. Until now every op was built with the default window (validAfter 0,
-- validUntil max uint48) and the routes hard-coded it; a creator-fee claim is now built with a finite validUntil
-- (5 minutes), so the window has to travel with the row.
--
-- valid_after / valid_until: unix seconds, uint48 range. Backfill policy: the column defaults ARE the default window,
-- and every row written before this migration was built with exactly that window (no finite window has ever been
-- deployed), so ADD COLUMN ... DEFAULT records the truth for existing rows and for any row an older app instance
-- writes during a rollout. Additive only: older code that does not name the columns keeps working.
--
-- Verification (after `pnpm db:migrate`):
--   \d aa_pending_user_ops
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'aa_pending_validity_window';
ALTER TABLE "aa_pending_user_ops" ADD COLUMN IF NOT EXISTS "valid_after" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "aa_pending_user_ops" ADD COLUMN IF NOT EXISTS "valid_until" bigint DEFAULT 281474976710655 NOT NULL;--> statement-breakpoint
ALTER TABLE "aa_pending_user_ops" DROP CONSTRAINT IF EXISTS "aa_pending_validity_window";--> statement-breakpoint
ALTER TABLE "aa_pending_user_ops" ADD CONSTRAINT "aa_pending_validity_window" CHECK (
  "valid_after" >= 0 AND "valid_after" < "valid_until" AND "valid_until" <= 281474976710655
);
