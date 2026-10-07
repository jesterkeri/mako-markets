-- Start over fence (Codex SIGNIN_R2 B1, 2026-10-07). Start over held a transaction-scoped advisory lock while it waited
-- on Privy's delete. If the function or the transaction ended mid-delete, the lock was released while Privy could still
-- finish deleting, and a first admission waiting on that lock could bind the account to a Privy user deleted a moment
-- later. A lock that vanishes cannot guard a remote side effect, so Start over now writes a durable fence first.
--
-- privy_start_over_fences: one row per Privy user that Start over found eligible (locked, never bound, no live
--   checkpoint) and committed to delete. Written and committed BEFORE the Privy delete is sent, in the same locked
--   transaction that clears that user's checkpoints. From then on no checkpoint of that Privy user counts (readCheckpoint
--   and hasLiveCheckpoint skip a fenced user), so no first admission can ever bind it, whatever happens to the delete.
--   deleted_at records the confirmed deletion (Privy's own "not found" after an error counts); a row without it is a
--   delete in flight or failed, and Start over again finishes it. Rows are never removed: a Privy user id is not reused.
--
-- Verification (after `pnpm db:migrate`):
--   \d privy_start_over_fences
CREATE TABLE IF NOT EXISTS "privy_start_over_fences" (
  "privy_user_id"  text PRIMARY KEY,
  "fenced_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at"     timestamp with time zone,
  CONSTRAINT "privy_start_over_fences_user_chk" CHECK (length("privy_user_id") BETWEEN 1 AND 200)
);
