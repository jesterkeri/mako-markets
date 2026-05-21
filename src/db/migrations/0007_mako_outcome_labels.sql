-- Phase: MAKO off-chain outcome labels. One table that stores admin-defined
-- binary labels for `MarketType.MAKO` markets, keyed by on-chain market id.
--
-- Hand-written migration (NOT `pnpm db:generate` output). The CHECK
-- constraint on byte length uses `octet_length`, which Drizzle's index DSL
-- has not been observed to emit reliably; SQL is the source of truth and
-- `schema.ts` mirrors only the column shape.
--
-- Why off-chain: `MakoMarketsV4` stores binary outcomes as
-- `Outcome.YES = 1` / `Outcome.NO = 2` with NO label fields. This table
-- lets admin-curated MAKO markets show custom labels (e.g. "APC" / "PDP")
-- without a contract redeploy. Labels are display-only; the contract's
-- 1/2 outcome remains the source of truth for resolution semantics.
--
-- Read access: public (label strings are not secrets). Write access:
-- SIWE admin only (see /api/admin/mako-labels).
--
-- Verification (post `pnpm db:migrate`):
--   SELECT relname FROM pg_class WHERE relname = 'mako_market_outcome_labels';
--   SELECT pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conname LIKE 'mako_market_outcome_labels_%';

CREATE TABLE "mako_market_outcome_labels" (
  "market_id"  bigint       PRIMARY KEY,
  "label_1"    text         NOT NULL,
  "label_2"    text         NOT NULL,
  "created_at" timestamptz  NOT NULL DEFAULT now(),
  "updated_at" timestamptz  NOT NULL DEFAULT now(),

  -- Byte caps mirror the round-9 plan + the `MAKO_LABEL_MAX_BYTES`
  -- constant in src/lib/mako-labels.ts. octet_length counts UTF-8 bytes,
  -- so non-ASCII labels (Yoruba diacritics, smart quotes from a paste)
  -- are bounded the same way the route validator bounds them.
  CONSTRAINT "mako_market_outcome_labels_label1_bytes_chk"
    CHECK (octet_length("label_1") BETWEEN 1 AND 32),
  CONSTRAINT "mako_market_outcome_labels_label2_bytes_chk"
    CHECK (octet_length("label_2") BETWEEN 1 AND 32)
);
