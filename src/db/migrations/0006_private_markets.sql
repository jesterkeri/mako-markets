-- Phase 2B-1: Private Markets indexer schema. Six tables that mirror
-- MakoPrivateMarketsV1 chain state into Postgres so the UI can serve
-- fast list/detail/profile queries without round-tripping the RPC.
--
-- Hand-written migration (NOT `pnpm db:generate` output). Several pieces
-- are not faithfully expressible through drizzle-kit's diff:
--   - Partial unique indexes with WHERE clauses on enum values
--     (slug-active, client_nonce-pending) — Drizzle generators have
--     historically rewritten these. The exact predicate matters for
--     "abandoned rows release their slug" semantics, so the SQL is the
--     source of truth and `schema.ts` mirrors only the column shape.
--   - CHECK constraints normalising lowercase EVM addresses + bytes32
--     hex form on every address/hash column. Same pattern used by the
--     AA tables in 0002.
--
-- Verification (post `pnpm db:migrate`):
--   SELECT relname FROM pg_class WHERE relname LIKE 'pm_%';
--     -> pm_markets, pm_options, pm_stakes, pm_resolutions, pm_claims,
--        pm_indexer_state (plus their PK / partial-unique / supporting
--        indexes).
--   SELECT pg_get_constraintdef(oid)
--     FROM pg_constraint WHERE conname LIKE 'pm_%_chk';

CREATE TYPE "public"."pm_market_shape" AS ENUM(
  'friendly', 'open_vote', 'prize_pool'
);--> statement-breakpoint

-- Mirrors the contract's STORED `MarketState` enum (event-driven values
-- only). `open` and `awaiting_creator` are NEVER written — they're
-- derived lazily by `effectiveState(row, now)` in queries.ts.
CREATE TYPE "public"."pm_market_state" AS ENUM(
  'created',
  'resolved',
  'empty_pool_resolved',
  'canceled',
  'timed_out',
  'zero_stake_expired'
);--> statement-breakpoint

CREATE TYPE "public"."pm_create_status" AS ENUM(
  'pending', 'confirmed', 'failed', 'abandoned'
);--> statement-breakpoint

-- Indexer cron coordination. One row per (chain_id, contract_address)
-- but in practice we ship a single row per chain since one v1 contract
-- runs at a time.
CREATE TABLE "pm_indexer_state" (
  "chain_id"           integer PRIMARY KEY,
  "contract_address"   varchar(42) NOT NULL,
  "last_indexed_block" bigint      DEFAULT 0 NOT NULL,
  "last_cleanup_at"    timestamp with time zone,
  "locked_at"          timestamp with time zone,
  "updated_at"         timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_indexer_state_contract_lower" CHECK (
    "contract_address" ~* '^0x[0-9a-f]{40}$' AND "contract_address" = lower("contract_address")
  ),
  CONSTRAINT "pm_indexer_state_block_nonneg" CHECK ("last_indexed_block" >= 0)
);--> statement-breakpoint

-- pm_markets — one row per market (pending or confirmed). Synthetic
-- direct-contract-write rows are also stored here with a `dx-` slug
-- prefix and `create_status='confirmed'`.
CREATE TABLE "pm_markets" (
  "id"                          uuid                     PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chain_id"                    integer                  NOT NULL,
  "contract_address"            varchar(42)              NOT NULL,
  "slug"                        text                     NOT NULL,
  "client_nonce"                varchar(66)              NOT NULL,
  "user_op_hash"                varchar(66),
  "market_id"                   bigint,
  "creator"                     varchar(42)              NOT NULL,
  "shape"                       "pm_market_shape"        NOT NULL,
  "create_status"               "pm_create_status"       DEFAULT 'pending' NOT NULL,
  "pending_at"                  timestamp with time zone DEFAULT now() NOT NULL,
  "confirmed_at"                timestamp with time zone,
  "failed_at"                   timestamp with time zone,
  "failure_reason"              text,
  "title"                       text                     NOT NULL,
  "description"                 text                     DEFAULT '' NOT NULL,
  "stream_url"                  text                     DEFAULT '' NOT NULL,
  "visibility_view"             smallint                 NOT NULL,
  "visibility_participation"    smallint                 NOT NULL,
  "staking_opens_at"            timestamp with time zone NOT NULL,
  "close_at"                    timestamp with time zone NOT NULL,
  "per_stake_min"               numeric(78,0)            DEFAULT 0 NOT NULL,
  "per_stake_max"               numeric(78,0)            DEFAULT 0 NOT NULL,
  "per_wallet_cumulative_max"   numeric(78,0)            DEFAULT 0 NOT NULL,
  "fixed_stake"                 numeric(78,0)            DEFAULT 0 NOT NULL,
  "winners_count"               smallint                 DEFAULT 0 NOT NULL,
  "current_state"               "pm_market_state"        DEFAULT 'created' NOT NULL,
  "friendly_outcome"            smallint,
  "friendly_empty_pool_path"    boolean,
  "fee_taken"                   numeric(78,0)            DEFAULT 0 NOT NULL,
  "dust"                        numeric(78,0)            DEFAULT 0 NOT NULL,
  "total_stake"                 numeric(78,0)            DEFAULT 0 NOT NULL,
  "frozen_at"                   timestamp with time zone,
  "created_at"                  timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"                  timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_markets_contract_lower" CHECK (
    "contract_address" ~* '^0x[0-9a-f]{40}$' AND "contract_address" = lower("contract_address")
  ),
  CONSTRAINT "pm_markets_creator_lower" CHECK (
    "creator" ~* '^0x[0-9a-f]{40}$' AND "creator" = lower("creator")
  ),
  CONSTRAINT "pm_markets_client_nonce_format" CHECK (
    "client_nonce" ~* '^0x[0-9a-f]{64}$' AND "client_nonce" = lower("client_nonce")
  ),
  CONSTRAINT "pm_markets_user_op_hash_format" CHECK (
    "user_op_hash" IS NULL
    OR ("user_op_hash" ~* '^0x[0-9a-f]{64}$' AND "user_op_hash" = lower("user_op_hash"))
  ),
  CONSTRAINT "pm_markets_visibility_view_chk" CHECK ("visibility_view" IN (0, 1)),
  CONSTRAINT "pm_markets_visibility_part_chk" CHECK ("visibility_participation" IN (0, 1)),
  CONSTRAINT "pm_markets_friendly_outcome_chk" CHECK (
    "friendly_outcome" IS NULL OR "friendly_outcome" IN (0, 1)
  ),
  CONSTRAINT "pm_markets_winners_count_chk" CHECK ("winners_count" >= 0 AND "winners_count" <= 10),
  -- timing self-consistency
  CONSTRAINT "pm_markets_close_after_open" CHECK ("close_at" > "staking_opens_at"),
  -- create-status side conditions
  CONSTRAINT "pm_markets_confirmed_has_market_id" CHECK (
    "create_status" != 'confirmed' OR "market_id" IS NOT NULL
  ),
  CONSTRAINT "pm_markets_failed_has_reason" CHECK (
    "create_status" NOT IN ('failed', 'abandoned') OR "failure_reason" IS NOT NULL
  )
);--> statement-breakpoint

-- Partial unique indexes per the plan: only ACTIVE rows reserve the
-- slug; abandoned/failed rows persist for audit but their slug is free
-- for a new market to claim. Same logic for client_nonce — only
-- in-flight pending rows must be unique.
CREATE UNIQUE INDEX "pm_markets_slug_active_uniq"
  ON "pm_markets" USING btree ("slug")
  WHERE "create_status" IN ('pending', 'confirmed');--> statement-breakpoint
CREATE UNIQUE INDEX "pm_markets_client_nonce_pending_uniq"
  ON "pm_markets" USING btree ("client_nonce")
  WHERE "create_status" = 'pending';--> statement-breakpoint
-- Indexer's MarketCreated correlation key: (creator, client_nonce)
-- restricted to pending rows. UPDATE ... WHERE create_status='pending'
-- AND client_nonce=? AND creator=?  flips exactly one row to confirmed.
CREATE INDEX "pm_markets_pending_correlation"
  ON "pm_markets" USING btree ("creator", "client_nonce")
  WHERE "create_status" = 'pending';--> statement-breakpoint
-- On-chain market_id lookup once confirmed. Uniqueness scoped per
-- contract: a future v2 contract gets its own marketId space.
CREATE UNIQUE INDEX "pm_markets_chain_market_id_uniq"
  ON "pm_markets" USING btree ("chain_id", "contract_address", "market_id")
  WHERE "market_id" IS NOT NULL;--> statement-breakpoint
-- Cleanup cron range scan: pending rows older than 1h.
CREATE INDEX "pm_markets_pending_age"
  ON "pm_markets" USING btree ("pending_at")
  WHERE "create_status" = 'pending';--> statement-breakpoint
-- Creator history feed.
CREATE INDEX "pm_markets_creator_confirmed"
  ON "pm_markets" USING btree ("creator", "confirmed_at" DESC)
  WHERE "create_status" = 'confirmed';--> statement-breakpoint
-- Public list feed (effective-state-derived; the index just narrows
-- to confirmed rows by close_at).
CREATE INDEX "pm_markets_confirmed_close_at"
  ON "pm_markets" USING btree ("close_at")
  WHERE "create_status" = 'confirmed';--> statement-breakpoint

-- pm_options — one row per (market, option). For Friendlies we always
-- store exactly two rows (option 0 = NO, option 1 = YES) so the
-- queries.ts layer doesn't have to special-case Friendly vs Vote shapes.
CREATE TABLE "pm_options" (
  "market_db_id"          uuid          NOT NULL,
  "option_index"          integer       NOT NULL,
  "label"                 text          NOT NULL,
  "participant_wallet"    varchar(42),
  "pool_total"            numeric(78,0) DEFAULT 0 NOT NULL,
  "first_stake_sequence"  integer,
  CONSTRAINT "pm_options_pkey" PRIMARY KEY ("market_db_id", "option_index"),
  CONSTRAINT "pm_options_participant_lower" CHECK (
    "participant_wallet" IS NULL
    OR ("participant_wallet" ~* '^0x[0-9a-f]{40}$' AND "participant_wallet" = lower("participant_wallet"))
  ),
  CONSTRAINT "pm_options_pool_nonneg" CHECK ("pool_total" >= 0),
  CONSTRAINT "pm_options_first_stake_seq_chk" CHECK (
    "first_stake_sequence" IS NULL OR "first_stake_sequence" > 0
  )
);--> statement-breakpoint
ALTER TABLE "pm_options"
  ADD CONSTRAINT "pm_options_market_fk"
  FOREIGN KEY ("market_db_id") REFERENCES "public"."pm_markets"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pm_options_participant_wallet"
  ON "pm_options" USING btree ("participant_wallet")
  WHERE "participant_wallet" IS NOT NULL;--> statement-breakpoint

-- pm_stakes — covers BOTH Friendly bets and Vote-shape stakes (the
-- contract emits a single `Staked` event for all three shapes). For
-- Friendlies, option_index ∈ {0, 1}.
-- PK is (tx_hash, log_index) per the plan; chain_id + contract_address
-- are stored for forward-compat but not part of the PK.
CREATE TABLE "pm_stakes" (
  "chain_id"          integer                  NOT NULL,
  "contract_address"  varchar(42)              NOT NULL,
  "tx_hash"           varchar(66)              NOT NULL,
  "log_index"         integer                  NOT NULL,
  "market_id"         bigint                   NOT NULL,
  "staker"            varchar(42)              NOT NULL,
  "option_index"      integer                  NOT NULL,
  "amount"            numeric(78,0)            NOT NULL,
  "block_number"      bigint                   NOT NULL,
  "block_timestamp"   timestamp with time zone NOT NULL,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_stakes_pkey" PRIMARY KEY ("tx_hash", "log_index"),
  CONSTRAINT "pm_stakes_tx_lower" CHECK (
    "tx_hash" ~* '^0x[0-9a-f]{64}$' AND "tx_hash" = lower("tx_hash")
  ),
  CONSTRAINT "pm_stakes_contract_lower" CHECK (
    "contract_address" ~* '^0x[0-9a-f]{40}$' AND "contract_address" = lower("contract_address")
  ),
  CONSTRAINT "pm_stakes_staker_lower" CHECK (
    "staker" ~* '^0x[0-9a-f]{40}$' AND "staker" = lower("staker")
  ),
  CONSTRAINT "pm_stakes_amount_pos" CHECK ("amount" > 0),
  CONSTRAINT "pm_stakes_log_index_nonneg" CHECK ("log_index" >= 0)
);--> statement-breakpoint
CREATE INDEX "pm_stakes_market"
  ON "pm_stakes" USING btree ("chain_id", "contract_address", "market_id");--> statement-breakpoint
CREATE INDEX "pm_stakes_market_staker"
  ON "pm_stakes" USING btree ("chain_id", "contract_address", "market_id", "staker");--> statement-breakpoint
CREATE INDEX "pm_stakes_staker"
  ON "pm_stakes" USING btree ("staker");--> statement-breakpoint
CREATE INDEX "pm_stakes_market_option"
  ON "pm_stakes" USING btree ("chain_id", "contract_address", "market_id", "option_index");--> statement-breakpoint

-- pm_resolutions — one row per resolution-class event (ResolvedFriendly
-- / ResolvedOpenVote / DistributedPrizePool / Canceled / MarketMetadataFrozen).
-- payload JSONB carries event-specific fields verbatim from the log
-- decode (topN, winnerWallets, amountsOwed, feeTaken, reason, etc.).
CREATE TABLE "pm_resolutions" (
  "chain_id"          integer                  NOT NULL,
  "contract_address"  varchar(42)              NOT NULL,
  "tx_hash"           varchar(66)              NOT NULL,
  "log_index"         integer                  NOT NULL,
  "market_id"         bigint                   NOT NULL,
  "event_name"        text                     NOT NULL,
  "payload"           jsonb                    NOT NULL,
  "block_number"      bigint                   NOT NULL,
  "block_timestamp"   timestamp with time zone NOT NULL,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_resolutions_pkey" PRIMARY KEY ("tx_hash", "log_index"),
  CONSTRAINT "pm_resolutions_tx_lower" CHECK (
    "tx_hash" ~* '^0x[0-9a-f]{64}$' AND "tx_hash" = lower("tx_hash")
  ),
  CONSTRAINT "pm_resolutions_contract_lower" CHECK (
    "contract_address" ~* '^0x[0-9a-f]{40}$' AND "contract_address" = lower("contract_address")
  ),
  CONSTRAINT "pm_resolutions_event_known" CHECK (
    "event_name" IN (
      'ResolvedFriendly',
      'ResolvedOpenVote',
      'DistributedPrizePool',
      'Canceled',
      'MarketMetadataFrozen'
    )
  ),
  CONSTRAINT "pm_resolutions_log_index_nonneg" CHECK ("log_index" >= 0)
);--> statement-breakpoint
CREATE INDEX "pm_resolutions_market"
  ON "pm_resolutions" USING btree ("chain_id", "contract_address", "market_id");--> statement-breakpoint
CREATE INDEX "pm_resolutions_market_event"
  ON "pm_resolutions" USING btree ("chain_id", "contract_address", "market_id", "event_name");--> statement-breakpoint

-- pm_claims — one row per `Claimed` event (user-claim or treasury-fee
-- claim). The Mako treasury address is the disambiguator vs user claims
-- per taxonomy; queries.ts uses `recipient = treasury` to pick out
-- treasury rows.
CREATE TABLE "pm_claims" (
  "chain_id"          integer                  NOT NULL,
  "contract_address"  varchar(42)              NOT NULL,
  "tx_hash"           varchar(66)              NOT NULL,
  "log_index"         integer                  NOT NULL,
  "market_id"         bigint                   NOT NULL,
  "recipient"         varchar(42)              NOT NULL,
  "amount"            numeric(78,0)            NOT NULL,
  "block_number"      bigint                   NOT NULL,
  "block_timestamp"   timestamp with time zone NOT NULL,
  "created_at"        timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_claims_pkey" PRIMARY KEY ("tx_hash", "log_index"),
  CONSTRAINT "pm_claims_tx_lower" CHECK (
    "tx_hash" ~* '^0x[0-9a-f]{64}$' AND "tx_hash" = lower("tx_hash")
  ),
  CONSTRAINT "pm_claims_contract_lower" CHECK (
    "contract_address" ~* '^0x[0-9a-f]{40}$' AND "contract_address" = lower("contract_address")
  ),
  CONSTRAINT "pm_claims_recipient_lower" CHECK (
    "recipient" ~* '^0x[0-9a-f]{40}$' AND "recipient" = lower("recipient")
  ),
  CONSTRAINT "pm_claims_amount_pos" CHECK ("amount" > 0),
  CONSTRAINT "pm_claims_log_index_nonneg" CHECK ("log_index" >= 0)
);--> statement-breakpoint
CREATE INDEX "pm_claims_market"
  ON "pm_claims" USING btree ("chain_id", "contract_address", "market_id");--> statement-breakpoint
CREATE INDEX "pm_claims_market_recipient"
  ON "pm_claims" USING btree ("chain_id", "contract_address", "market_id", "recipient");--> statement-breakpoint
CREATE INDEX "pm_claims_recipient"
  ON "pm_claims" USING btree ("recipient");
