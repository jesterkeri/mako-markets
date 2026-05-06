-- Wallet-mode auth: a `users` row may now be backed by either a Magic
-- account (email + magic_eoa) or an external wallet (wallet_address).
-- The CHECK constraint enforces "exactly one identity shape per row".
-- Lowercase + EVM-format CHECKs plus an application-level toLowerCase()
-- in upsertWalletUser canonicalize the address.

ALTER TABLE "users"
  ALTER COLUMN "email"     DROP NOT NULL,
  ALTER COLUMN "magic_eoa" DROP NOT NULL;

ALTER TABLE "users"
  ADD COLUMN "wallet_address" text,
  ADD COLUMN "auth_type"      text NOT NULL DEFAULT 'magic';

-- The auth-shape constraint. Existing rows are auth_type='magic' and
-- already satisfy this; verify before applying with the SELECTs in
-- the plan's "Migration verification" block.
ALTER TABLE "users"
  ADD CONSTRAINT "users_auth_type_chk"
  CHECK (
    (auth_type = 'magic'
       AND email IS NOT NULL
       AND magic_eoa IS NOT NULL
       AND wallet_address IS NULL)
    OR
    (auth_type = 'wallet'
       AND wallet_address IS NOT NULL
       AND email IS NULL
       AND magic_eoa IS NULL)
  );

-- Lowercase canonicalization.
ALTER TABLE "users"
  ADD CONSTRAINT "users_wallet_address_lower_chk"
  CHECK (wallet_address IS NULL OR wallet_address = lower(wallet_address));

-- Wallet-address format. Defense-in-depth at the DB layer so the
-- CHECK suite fully defines the wallet identity shape; raw-SQL /
-- test / helper mistakes that try to insert non-EVM-format strings
-- get caught here regardless of what app code does.
ALTER TABLE "users"
  ADD CONSTRAINT "users_wallet_address_format_chk"
  CHECK (wallet_address IS NULL OR wallet_address ~ '^0x[0-9a-f]{40}$');

-- Partial unique index. Lives in raw SQL because Drizzle's index DSL
-- doesn't reliably emit WHERE clauses (same pattern aa_pending_user_ops
-- and recovery_codes use). The partial-where is what makes the index
-- correct — multiple Magic rows must coexist with NULL wallet_address.
CREATE UNIQUE INDEX "users_wallet_address_uniq"
  ON "users" ("wallet_address")
  WHERE "wallet_address" IS NOT NULL;
