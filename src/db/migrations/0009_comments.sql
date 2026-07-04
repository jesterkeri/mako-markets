-- #182 Comments: per-market comment threads (main + private markets) + a
-- per-user attempt-rate bucket + the PM creator's comments on/off toggle.
--
-- Hand-written migration (NOT `pnpm db:generate` output), same policy as
-- 0002-0008. CHECK constraints are SQL-only; src/db/schema.ts mirrors the
-- column shape.
--
-- market_comments holds BOTH scopes ('main' MakoMarketsV4 markets keyed by
-- (chain_id, contract_address, market_id); 'pm' private markets keyed by the
-- pm_markets row id) so the reply / soft-delete / pagination machinery exists
-- once. The server STAMPS the main target from env (client sends only the
-- market id / PM slug) — see src/app/api/comments/*.
--
-- Invariants enforced here, relied on by src/lib/comments/*:
--   - scope shape: a 'main' row carries (chain_id, contract_address,
--     market_id) and NO pm_market_db_id; a 'pm' row carries pm_market_db_id
--     and none of the main columns. One CHECK, both directions.
--   - contract_address is LOWERCASE (matches mako_market_events; the position-
--     badge join lower()s both sides, but comment-side casing must be canonical
--     so a future re-key stays consistent).
--   - deleted_at / deleted_by are set together or both null (soft-delete pair).
--   - body is 1..2000 BYTES (octet_length, so multi-byte input can't exceed the
--     storage/UX bound the validator also enforces).
--   - ONE-LEVEL reply depth (a reply may not be a parent) is NOT a DB constraint
--     — it needs a cross-row check (trigger). Enforced in the POST handler; its
--     violation is cosmetic, not financial. Documented, accepted gap.
--   - parent_id ON DELETE CASCADE is correct-by-construction only; the app path
--     is soft-delete (deleted_at), so the cascade never fires in normal use.
--
-- comment_rate_limits is a per-(user, window) ATTEMPT counter, incremented
-- atomically BEFORE the getMarket RPC in the POST handler (the incrementOrReject
-- shape from aa_sponsor_limits). It counts every attempt — including ones that
-- 404 — so nonexistent-marketId spam throttles and the RPC is bounded. window_key
-- is 'm:<floor(epoch/60)>' (60s, cap 4) or 'd:<yyyy-mm-dd UTC>' (per UTC calendar
-- day, cap 100 — matches the sponsor limiter; the <=200-across-UTC-midnight edge
-- is accepted, still 4/min-bounded).
--
-- Verification (post `pnpm db:migrate`):
--   SELECT relname FROM pg_class
--    WHERE relname IN ('market_comments', 'comment_rate_limits');
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'pm_markets' AND column_name = 'comments_enabled';
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint WHERE conname LIKE 'market_comments_%';

CREATE TABLE IF NOT EXISTS "market_comments" (
  "id"               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope"            text          NOT NULL,

  -- main-market target (all three present iff scope='main')
  "chain_id"         integer,
  "contract_address" varchar(42),
  "market_id"        text,

  -- PM target (present iff scope='pm')
  "pm_market_db_id"  uuid          REFERENCES "pm_markets"("id") ON DELETE CASCADE,

  "user_id"          uuid          NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "parent_id"        uuid          REFERENCES "market_comments"("id") ON DELETE CASCADE,
  "body"             text          NOT NULL,
  "deleted_at"       timestamptz,
  "deleted_by"       text,
  "created_at"       timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT "market_comments_scope_chk"
    CHECK ("scope" IN ('main', 'pm')),
  CONSTRAINT "market_comments_deleted_by_chk"
    CHECK ("deleted_by" IS NULL OR "deleted_by" IN ('owner', 'admin')),
  CONSTRAINT "market_comments_body_len_chk"
    CHECK (octet_length("body") BETWEEN 1 AND 2000),
  CONSTRAINT "market_comments_scope_shape_chk"
    CHECK (
      ("scope" = 'main' AND "chain_id" IS NOT NULL AND "contract_address" IS NOT NULL
         AND "market_id" IS NOT NULL AND "pm_market_db_id" IS NULL)
      OR
      ("scope" = 'pm' AND "pm_market_db_id" IS NOT NULL AND "chain_id" IS NULL
         AND "contract_address" IS NULL AND "market_id" IS NULL)
    ),
  CONSTRAINT "market_comments_contract_lower_chk"
    CHECK ("contract_address" IS NULL OR "contract_address" = lower("contract_address")),
  CONSTRAINT "market_comments_deleted_pair_chk"
    CHECK (("deleted_at" IS NULL) = ("deleted_by" IS NULL))
);

-- Top-level main-market listing: newest-first keyset over (created_at, id).
CREATE INDEX IF NOT EXISTS "market_comments_main_idx"
  ON "market_comments" ("chain_id", "contract_address", "market_id", "created_at" DESC, "id" DESC)
  WHERE "scope" = 'main';
-- Top-level PM listing.
CREATE INDEX IF NOT EXISTS "market_comments_pm_idx"
  ON "market_comments" ("pm_market_db_id", "created_at" DESC, "id" DESC)
  WHERE "scope" = 'pm';
-- Reply lookup (parent_id = ANY(page) ORDER BY created_at, id) + the
-- load-more-replies keyset.
CREATE INDEX IF NOT EXISTS "market_comments_parent_idx"
  ON "market_comments" ("parent_id", "created_at", "id")
  WHERE "parent_id" IS NOT NULL;

-- Per-user attempt bucket. See header. count>=0 is a defensive belt (there is
-- no decrement/refund path for comments, unlike the sponsor limiter).
CREATE TABLE IF NOT EXISTS "comment_rate_limits" (
  "user_id"    uuid    NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "window_key" text    NOT NULL,
  "count"      integer NOT NULL DEFAULT 0,

  CONSTRAINT "comment_rate_limits_pk" PRIMARY KEY ("user_id", "window_key"),
  CONSTRAINT "comment_rate_limits_count_nonneg_chk" CHECK ("count" >= 0)
);

-- PM creator toggle (Slice B). Default ON; flippable from the market page by
-- the creator. The whole PM comment surface ships dark behind isPmEnabled().
ALTER TABLE "pm_markets"
  ADD COLUMN IF NOT EXISTS "comments_enabled" boolean NOT NULL DEFAULT true;
