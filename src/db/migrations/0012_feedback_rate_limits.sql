-- Feedback abuse limit (2026-10-01). POST /api/feedback forwards a tester's message to Telegram; this table caps how
-- many a sender can send per clock hour, in the increment-or-reject shape of comment_rate_limits (0009): the counter
-- is bumped inside a transaction and the transaction rolls back when the bump goes over the cap, so a rejected
-- attempt consumes nothing.
--
-- `key` is 'u:<users.id>' for a signed-in sender (5 an hour) or the single shared 'anon' key that every signed-out
-- sender counts against together (30 an hour). No IP address, hashed or not, is ever stored. `window_key` is
-- 'h:<floor(epoch_seconds / 3600)>'. The limiter deletes a key's older windows in the same transaction, so the table
-- holds at most one row per key.
--
-- Verification (after `pnpm db:migrate`):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname LIKE 'feedback_rate_limits_%';
CREATE TABLE IF NOT EXISTS "feedback_rate_limits" (
  "key"        text    NOT NULL,
  "window_key" text    NOT NULL,
  "count"      integer NOT NULL DEFAULT 0,

  CONSTRAINT "feedback_rate_limits_pk" PRIMARY KEY ("key", "window_key"),
  CONSTRAINT "feedback_rate_limits_count_nonneg_chk" CHECK ("count" >= 0),
  CONSTRAINT "feedback_rate_limits_key_chk" CHECK ("key" = 'anon' OR "key" ~ '^u:[0-9a-f-]{36}$'),
  CONSTRAINT "feedback_rate_limits_window_chk" CHECK ("window_key" ~ '^h:[0-9]{1,12}$')
);
