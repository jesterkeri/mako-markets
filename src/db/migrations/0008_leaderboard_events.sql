-- #186 Leaderboard: main-market event ledger + indexer cursor.
--
-- Hand-written migration (NOT `pnpm db:generate` output), same policy as
-- 0002-0007. CHECK constraints are SQL-only; src/db/schema.ts mirrors the
-- column shape.
--
-- mako_market_events is a raw event ledger for the MAIN MakoMarketsV4
-- contract (BetPlaced / Claimed / CreatorFeePaid). The leaderboard
-- aggregates it at read time (Net PnL = SUM(claim) - SUM(bet) per actor);
-- nothing here stores running totals, so re-ingest is idempotent and
-- weekly windows are a block_timestamp filter.
--
-- Invariants enforced here, relied on by src/lib/leaderboard/*:
--   - actor / contract_address / tx_hash are LOWERCASE. The ingest path
--     normalizes; these CHECKs make drift a hard error instead of a
--     silently-broken identity join (user_safes.safe_address is stored
--     checksummed, so the join lower()s both sides — but ledger-side
--     casing must still be canonical for GROUP BY actor to be correct).
--   - kind is one of ('bet','claim','creator_fee'). Text + CHECK rather
--     than a pg enum: adding kind='resolution' for the v2 win% metric is
--     a constraint swap (DROP + ADD), not an ALTER TYPE.
--   - is_yes present exactly when kind='bet'.
--   - PK (tx_hash, log_index): the idempotency target for
--     onConflictDoNothing during the trailing/seed re-scans. Reorg safety
--     itself comes from the indexer's CONFIRMATIONS horizon (it never
--     scans within CONFIRMATIONS of head); there is NO deletion path —
--     a reorg deeper than CONFIRMATIONS requires the manual re-sync
--     runbook (truncate both tables, reset cursor, re-run the seed).
--
-- Verification (post `pnpm db:migrate`):
--   SELECT relname FROM pg_class
--    WHERE relname IN ('mako_market_events', 'mako_leaderboard_indexer_state');
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conname LIKE 'mako_market_events_%';

CREATE TABLE IF NOT EXISTS "mako_market_events" (
  "chain_id"         integer       NOT NULL,
  "contract_address" varchar(42)   NOT NULL,
  "version"          text          NOT NULL,
  "market_id"        text          NOT NULL,
  "kind"             text          NOT NULL,
  "actor"            varchar(42)   NOT NULL,
  "is_yes"           boolean,
  "amount"           numeric(78,0) NOT NULL,
  "block_number"     bigint        NOT NULL,
  "block_timestamp"  timestamptz   NOT NULL,
  "tx_hash"          varchar(66)   NOT NULL,
  "log_index"        integer       NOT NULL,
  "created_at"       timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT "mako_market_events_tx_hash_log_index_pk"
    PRIMARY KEY ("tx_hash", "log_index"),
  CONSTRAINT "mako_market_events_kind_chk"
    CHECK ("kind" IN ('bet', 'claim', 'creator_fee')),
  CONSTRAINT "mako_market_events_is_yes_chk"
    CHECK (("kind" = 'bet' AND "is_yes" IS NOT NULL)
        OR ("kind" <> 'bet' AND "is_yes" IS NULL)),
  CONSTRAINT "mako_market_events_amount_nonneg_chk"
    CHECK ("amount" >= 0),
  CONSTRAINT "mako_market_events_actor_lower_chk"
    CHECK ("actor" = lower("actor")),
  CONSTRAINT "mako_market_events_contract_lower_chk"
    CHECK ("contract_address" = lower("contract_address")),
  CONSTRAINT "mako_market_events_tx_hash_lower_chk"
    CHECK ("tx_hash" = lower("tx_hash"))
);

CREATE INDEX IF NOT EXISTS "mako_market_events_actor"
  ON "mako_market_events" ("actor");
CREATE INDEX IF NOT EXISTS "mako_market_events_kind"
  ON "mako_market_events" ("kind");
CREATE INDEX IF NOT EXISTS "mako_market_events_block_timestamp"
  ON "mako_market_events" ("block_timestamp");
CREATE INDEX IF NOT EXISTS "mako_market_events_contract"
  ON "mako_market_events" ("chain_id", "contract_address");

-- One cursor row per (chain, contract) in LEADERBOARD_CONTRACTS. Seeded
-- lazily by the indexer (first tick inserts at the contract's deployBlock).
-- locked_at is the worker lock; its stale-recovery threshold must exceed
-- the cron route's maxDuration (enforced by a unit test, stated in the
-- cron route comment) or a long backfill tick gets its lock reclaimed
-- mid-run by the next cron fire.
CREATE TABLE IF NOT EXISTS "mako_leaderboard_indexer_state" (
  "chain_id"           integer     NOT NULL,
  "contract_address"   varchar(42) NOT NULL,
  "last_scanned_block" bigint      NOT NULL DEFAULT 0,
  "locked_at"          timestamptz,
  "updated_at"         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "mako_leaderboard_indexer_state_pk"
    PRIMARY KEY ("chain_id", "contract_address"),
  CONSTRAINT "mako_leaderboard_indexer_state_contract_lower_chk"
    CHECK ("contract_address" = lower("contract_address"))
);
