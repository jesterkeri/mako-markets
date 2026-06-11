// ----------------------------------------------------------------------------
// src/db/schema.ts
//
// Drizzle schema for the Phase 1+ onboarding database. Every table has exactly
// one source-of-truth claim documented next to it, matching the source-of-truth
// matrix in plans/logical-dancing-liskov.md.
//
// The invariant worth repeating: settled USDC on Monad (the chain) is the only
// spendable balance. Rows in this database are audit trails and webhook
// bookkeeping — they never authorize a bet on their own. Bet authorization
// comes from an on-chain balance read at submit time.
// ----------------------------------------------------------------------------

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  integer,
  bigint,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  numeric,
  date,
  primaryKey,
} from 'drizzle-orm/pg-core';

import type { StoredSplitFormUserOp } from '@/lib/user-op-types';

// ----------------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------------

export const kycStatusEnum = pgEnum('kyc_status', [
  'none',
  'pending',
  'approved',
  'rejected',
]);

export const fiatProviderEnum = pgEnum('fiat_provider', [
  'moonpay',
  'monnify',
]);

export const fiatPaymentStatusEnum = pgEnum('fiat_payment_status', [
  'initiated',
  'paid',
  'failed',
  'refunded',
]);

export const depositSourceEnum = pgEnum('deposit_source', [
  'crypto_direct',
  'fiat_settlement',
  'bridge',
]);

export const bridgeStatusEnum = pgEnum('bridge_status', [
  'initiated',
  'burned',
  'attested',
  'claimed',
  'failed',
]);

export const withdrawalTypeEnum = pgEnum('withdrawal_type', [
  'crypto',
  'naira',
]);

export const withdrawalStatusEnum = pgEnum('withdrawal_status', [
  'initiated',
  'pending',
  'completed',
  'failed',
]);

export const kycProviderEnum = pgEnum('kyc_provider', ['smile_identity']);

export const providerWebhookProviderEnum = pgEnum('provider_webhook_provider', [
  'alchemy',
  'moonpay',
  'monnify',
  'flutterwave',
  'smile_identity',
]);

export const providerWebhookStatusEnum = pgEnum('provider_webhook_status', [
  'active',
  'failed',
  'disabled',
]);

// Phase 1B sub-phase C: ERC-4337 user-op state machine. The full transition
// graph + invariants live in src/lib/aa-pending-user-ops.ts; this enum lists
// every legal status the partial unique index + CHECK constraints recognise.
export const aaPendingStatusEnum = pgEnum('aa_pending_status', [
  'pending',
  'sending',
  'submitted',
  'sent',
  'reverted',
  'failed_pre_submit',
  'expired',
  'ambiguous',
]);

// Phase 2B: Private Markets. Mirrors MakoPrivateMarketsV1 contract enums.
// `pmMarketStateEnum` lists ONLY event-driven values — `Open` and
// `AwaitingCreator` are derived lazily by `effectiveState(row, now)` in
// queries.ts and never persisted.
export const pmMarketShapeEnum = pgEnum('pm_market_shape', [
  'friendly',
  'open_vote',
  'prize_pool',
]);

export const pmMarketStateEnum = pgEnum('pm_market_state', [
  'created',
  'resolved',
  'empty_pool_resolved',
  'canceled',
  'timed_out',
  'zero_stake_expired',
]);

export const pmCreateStatusEnum = pgEnum('pm_create_status', [
  'pending',
  'confirmed',
  'failed',
  'abandoned',
]);

// ----------------------------------------------------------------------------
// users — source of truth: this DB. One row per identity, where an identity
// is either a Magic account (auth_type='magic', email + magic_eoa NOT NULL,
// wallet_address NULL) or an external wallet (auth_type='wallet',
// wallet_address NOT NULL, email + magic_eoa NULL). The DB enforces the
// shape via `users_auth_type_chk` (see migration 0005). Application code
// MUST route writes through `upsertMagicUser` or `upsertWalletUser` — never
// hand-rolled INSERTs — so the CHECK never gets a chance to reject in the
// hot path.
// ----------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  /// Magic-side identity. NULL for wallet rows.
  email: text('email'),
  /// Magic-side identity. NULL for wallet rows.
  magicEoa: text('magic_eoa'),
  /// Wallet-side identity. NULL for Magic rows. Stored canonical
  /// lowercase (DB CHECK + helper assertion both enforce). Partial
  /// unique index `users_wallet_address_uniq` lives in raw migration
  /// SQL because Drizzle's index DSL can't emit `WHERE` clauses
  /// reliably.
  walletAddress: text('wallet_address'),
  /// Discriminator. 'magic' for legacy + Magic-onboarded rows;
  /// 'wallet' for SIWE-authed external-wallet rows. Default 'magic'
  /// matches every row that existed pre-migration 0005.
  authType: text('auth_type').notNull().default('magic'),
  kycStatus: kycStatusEnum('kyc_status').notNull().default('none'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /// Timestamp of the most recent email change (or null if never changed).
  /// Mako's policy: a user may change their email at most once per year.
  /// Enforced server-side in /api/user/email/update; surfaced via
  /// /api/user/me so the UI can disable the EDIT affordance during the
  /// cooldown window. Email rotation is the only way to rotate the
  /// account's recovery surface, so loose change-frequency would
  /// invite session-compromise → email-rotation → permanent lockout
  /// patterns. The annual cap pushes the security model onto 2FA on
  /// the email account itself, which is the intended posture.
  lastEmailChangedAt: timestamp('last_email_changed_at', {
    withTimezone: true,
  }),
  /// Phase 1G: identity surface.
  /// display_name is mutable any time, validated server-side as
  /// [a-zA-Z0-9 ._-]{1,32}. Null = use email/EOA fallback in UI.
  displayName: text('display_name'),
  /// avatar_url is a Vercel Blob URL produced by
  /// /api/user/avatar/upload (multipart → sharp resize 256x256 webp →
  /// blob put). The upload route is the ONLY non-null writer:
  /// /api/user/profile/update accepts only `null` for this column
  /// (clear). The route's prior-blob cleanup is scoped to
  /// `/avatars/<sessionUserId>/` paths so a foreign URL can't trigger
  /// deletion of someone else's blob. Rendered client-side with
  /// referrerPolicy="no-referrer" (camelCase JSX prop).
  avatarUrl: text('avatar_url'),
  /// totp_secret is the AES-256-GCM ciphertext of the user's TOTP secret,
  /// bound to (userId, slot='users.totp_secret') as AAD. Null = 2FA off.
  /// NEVER returned over the wire (encrypted or plaintext) on any route.
  totpSecret: text('totp_secret'),
  /// Set by verify-enrollment when the conditional UPDATE commits.
  /// Cleared by the disable route.
  totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
  /// Atomic-increment counter on bad TOTP / recovery-code attempts.
  /// Crosses the lockout threshold inside the same UPDATE that bumps
  /// totp_locked_until. Zeroed on successful sign-in.
  totpFailedAttempts: integer('totp_failed_attempts').notNull().default(0),
  /// Non-null while a 15-min lockout is in flight. Cleared on successful
  /// sign-in alongside totp_failed_attempts = 0.
  totpLockedUntil: timestamp('totp_locked_until', { withTimezone: true }),
  /// Last successfully-consumed TOTP step (Math.floor(unixTime/30)).
  /// Sign-in's TOTP path enforces last_used_step IS NULL OR
  /// last_used_step < matchedStep so a code can't be replayed within
  /// its 30s window.
  totpLastUsedStep: bigint('totp_last_used_step', { mode: 'bigint' }),
}, (t) => ({
  emailUniq: uniqueIndex('users_email_uniq').on(t.email),
  magicEoaUniq: uniqueIndex('users_magic_eoa_uniq').on(t.magicEoa),
}));

// ----------------------------------------------------------------------------
// user_safes — Path X locked, but schema keeps (user_id, chain_id, safe_address)
// to stay resilient if a future chain pairing ever invalidates same-address.
// Populated lazily — a row is inserted when the Safe is first derived; the
// `deployedAt` column is backfilled when the Safe is actually deployed on-chain.
// ----------------------------------------------------------------------------
export const userSafes = pgTable(
  'user_safes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chainId: integer('chain_id').notNull(),
    safeAddress: text('safe_address').notNull(),
    deployedAt: timestamp('deployed_at', { withTimezone: true }),
  },
  (t) => ({
    userChainUniq: uniqueIndex('user_safes_user_chain_uniq').on(
      t.userId,
      t.chainId,
    ),
    safeAddressIdx: index('user_safes_safe_address_idx').on(t.safeAddress),
  }),
);

// ----------------------------------------------------------------------------
// allowlist_emails — gates beta signup. Rows are added via the SIWE-protected
// admin endpoint POST /api/admin/allowlist/add. The auth handler checks this
// table before issuing a session.
// ----------------------------------------------------------------------------
export const allowlistEmails = pgTable(
  'allowlist_emails',
  {
    email: text('email').primaryKey(),
    addedBy: text('added_by').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

// ----------------------------------------------------------------------------
// sessions — session row per live user cookie. The `id` (UUID) is carried in
// the HMAC-signed cookie and looked up on every request; presence of the row
// + expiresAt > now is what validates the session. Deleting the row revokes
// it immediately — HMAC cookies without a matching row fail the DB check
// regardless of their cryptographic validity.
//
// No column stores the cookie itself. Persisting the HMAC-signed token would
// turn any read-only DB leak into an immediate session-replay primitive
// (attacker lifts hmac_token values, pastes them into a browser, is signed in
// as each user without ever needing USER_SESSION_SECRET). The `id` + HMAC
// pair is the credential; we never want both halves to live in one place.
// ----------------------------------------------------------------------------
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => ({
  userIdx: index('sessions_user_id_idx').on(t.userId),
}));

// ----------------------------------------------------------------------------
// fiat_payments — source of truth: payment provider webhook.
//
// A row here says "the provider thinks they got paid". It does NOT mean the
// user has spendable USDC on Monad. Settlement — the on-chain Transfer event
// to the user's Safe — is tracked separately in `deposits`.
//
// amount_usdc is the expected USDC delivery, not the confirmed one. Compare
// against the matching `deposits` row to detect divergence.
//
// numeric(20,6) stores USDC with full 6-decimal precision (up to 10^14 USDC
// total — more than ample). numeric(20,2) covers fiat.
// ----------------------------------------------------------------------------
export const fiatPayments = pgTable(
  'fiat_payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    provider: fiatProviderEnum('provider').notNull(),
    providerTxId: text('provider_tx_id').notNull(),
    amountFiat: numeric('amount_fiat', { precision: 20, scale: 2 }).notNull(),
    currencyFiat: text('currency_fiat').notNull(),
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    destChainId: integer('dest_chain_id').notNull(),
    destSafeAddress: text('dest_safe_address').notNull(),
    status: fiatPaymentStatusEnum('status').notNull().default('initiated'),
    stateHistory: jsonb('state_history')
      .$type<Array<{ at: string; from: string; to: string; note?: string }>>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => ({
    providerTxUniq: uniqueIndex('fiat_payments_provider_tx_uniq').on(
      t.provider,
      t.providerTxId,
    ),
    userIdx: index('fiat_payments_user_idx').on(t.userId),
    statusIdx: index('fiat_payments_status_idx').on(t.status),
  }),
);

// ----------------------------------------------------------------------------
// deposits — source of truth: on-chain Transfer event, confirmed past reorg
// depth. Rows only exist in `settled` state. The composite uniqueness on
// (chain_id, tx_hash, log_index) is what makes webhook replay + reconciliation
// idempotent: every path that inserts a deposit fingerprints it the same way.
//
// amount_usdc is the amount observed on chain. If a fiat_payment says $100 but
// the on-chain deposit is $99, the fiat_payment is lying (or the user got
// skimmed) — spendable is always what the chain says.
// ----------------------------------------------------------------------------
export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    chainId: integer('chain_id').notNull(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    source: depositSourceEnum('source').notNull(),
    fiatPaymentId: uuid('fiat_payment_id').references(() => fiatPayments.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    chainTxLogUniq: uniqueIndex('deposits_chain_tx_log_uniq').on(
      t.chainId,
      t.txHash,
      t.logIndex,
    ),
    userIdx: index('deposits_user_idx').on(t.userId),
    sourceIdx: index('deposits_source_idx').on(t.source),
  }),
);

// ----------------------------------------------------------------------------
// bridges — CCTP v2 Base → Monad transfer state machine. Originates from a
// MoonPay-on-Base settlement; user signs the burn user op; Circle attests;
// user signs the mint user op on Monad. The `claimed` state implies a matching
// `deposits` row with source=bridge exists.
// ----------------------------------------------------------------------------
export const bridges = pgTable(
  'bridges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sourceChainId: integer('source_chain_id').notNull(),
    destChainId: integer('dest_chain_id').notNull(),
    sourceTxHash: text('source_tx_hash'),
    destTxHash: text('dest_tx_hash'),
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    status: bridgeStatusEnum('status').notNull().default('initiated'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('bridges_user_idx').on(t.userId),
    statusIdx: index('bridges_status_idx').on(t.status),
    sourceTxIdx: index('bridges_source_tx_idx').on(t.sourceTxHash),
  }),
);

// ----------------------------------------------------------------------------
// withdrawals — crypto type ships a `tx_hash`; naira type ships a payout
// reference (Flutterwave's tracking id). bankDetails is JSONB to stay flexible
// across payout providers without a schema change.
// ----------------------------------------------------------------------------
export const withdrawals = pgTable(
  'withdrawals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: withdrawalTypeEnum('type').notNull(),
    txHash: text('tx_hash'),
    payoutReference: text('payout_reference'),
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    recipientAddress: text('recipient_address'),
    bankDetails: jsonb('bank_details').$type<Record<string, string>>(),
    status: withdrawalStatusEnum('status').notNull().default('initiated'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('withdrawals_user_idx').on(t.userId),
    statusIdx: index('withdrawals_status_idx').on(t.status),
  }),
);

// ----------------------------------------------------------------------------
// kyc_records — mirror of Smile Identity's verification result. Nullable
// verified_at tracks when the `approved` transition happened (not row-insert
// time). A user may have multiple rows if they re-attempt after a rejection.
// ----------------------------------------------------------------------------
export const kycRecords = pgTable(
  'kyc_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: kycProviderEnum('provider').notNull(),
    providerRef: text('provider_ref').notNull(),
    status: kycStatusEnum('status').notNull().default('pending'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerRefUniq: uniqueIndex('kyc_records_provider_ref_uniq').on(
      t.provider,
      t.providerRef,
    ),
    userIdx: index('kyc_records_user_idx').on(t.userId),
  }),
);

// ----------------------------------------------------------------------------
// provider_webhooks — ownership registry for webhooks we've registered with
// external providers. resource_id is the logical target (user id, safe
// address, whatever's relevant). webhook_id is the provider's identifier so
// we can DELETE it later. retry_count + last_failed_at power a cron that
// re-registers webhooks that silently stopped firing.
// ----------------------------------------------------------------------------
export const providerWebhooks = pgTable(
  'provider_webhooks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: providerWebhookProviderEnum('provider').notNull(),
    resourceId: text('resource_id').notNull(),
    webhookId: text('webhook_id').notNull(),
    subscriptionScope: jsonb('subscription_scope')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: providerWebhookStatusEnum('status').notNull().default('active'),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),
    retryCount: integer('retry_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerWebhookUniq: uniqueIndex('provider_webhooks_provider_webhook_uniq')
      .on(t.provider, t.webhookId),
    resourceIdx: index('provider_webhooks_resource_idx').on(
      t.provider,
      t.resourceId,
    ),
    statusIdx: index('provider_webhooks_status_idx').on(t.status),
  }),
);

// ----------------------------------------------------------------------------
// chain_state — bookmark for reconciliation. Each chain has its own row.
// last_confirmed_block is the highest block the reconciler has finalized past
// reorg_depth. Scans resume from (last_confirmed_block - reorg_depth - 100).
// ----------------------------------------------------------------------------
export const chainState = pgTable('chain_state', {
  chainId: integer('chain_id').primaryKey(),
  lastConfirmedBlock: bigint('last_confirmed_block', { mode: 'bigint' })
    .notNull(),
  reorgDepth: integer('reorg_depth').notNull().default(12),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ----------------------------------------------------------------------------
// aa_pending_user_ops — source of truth for in-flight + terminal ERC-4337
// state. The partial unique index `aa_pending_one_in_flight` (created in the
// migration, NOT here — Drizzle's index DSL doesn't emit `WHERE` clauses
// safely on every version we've seen) is the only concurrency primitive:
// one row per (chain_id, safe_address) in any of the in-flight statuses
// (`pending`, `sending`, `submitted`, `ambiguous`).
//
// CHECK constraints + the partial unique index are emitted as raw SQL in the
// migration to avoid Drizzle's generator rewriting subtle predicates. Schema
// types here are 1:1 with the migration so types stay accurate; the
// constraint enforcement lives at the DB layer.
// ----------------------------------------------------------------------------
export const aaPendingUserOps = pgTable(
  'aa_pending_user_ops',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chainId: integer('chain_id').notNull(),
    safeAddress: varchar('safe_address', { length: 42 }).notNull(),
    magicEoa: varchar('magic_eoa', { length: 42 }).notNull(),
    userOp: jsonb('user_op').$type<StoredSplitFormUserOp>().notNull(),
    nonceHex: varchar('nonce_hex', { length: 66 }).notNull(),
    safeOpHash: varchar('safe_op_hash', { length: 66 }).notNull(),
    status: aaPendingStatusEnum('status').notNull().default('pending'),
    userOpHash: varchar('user_op_hash', { length: 66 }),
    txHash: varchar('tx_hash', { length: 66 }),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sendingStartedAt: timestamp('sending_started_at', { withTimezone: true }),
    statusUpdatedAt: timestamp('status_updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('aa_pending_user_id').on(t.userId),
    pendingExpiresIdx: index('aa_pending_pending_expires').on(t.expiresAt),
    sendingStartedIdx: index('aa_pending_sending_started').on(t.sendingStartedAt),
    submittedAgeIdx: index('aa_pending_submitted_age').on(t.statusUpdatedAt),
    ambiguousAgeIdx: index('aa_pending_ambiguous_age').on(t.statusUpdatedAt),
  }),
);

// ----------------------------------------------------------------------------
// aa_sponsor_limits — atomic-increment rate-limit table for Pimlico sponsor
// requests. The DB CHECK `count >= 0` plus `GREATEST(count - 1, 0)` in the
// refund SQL guards against double-refund bugs.
// ----------------------------------------------------------------------------
export const aaSponsorLimits = pgTable(
  'aa_sponsor_limits',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chainId: integer('chain_id').notNull(),
    day: date('day').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.chainId, t.day] }),
    dayIdx: index('aa_sponsor_limits_day').on(t.day),
  }),
);

// ----------------------------------------------------------------------------
// Phase 1G — TOTP 2FA + recovery codes.
//
// recovery_codes is bcrypt-hashed one-time codes. The partial index on
// (user_id) WHERE used_at IS NULL keeps the unused-code lookup cheap as
// users accumulate consumed codes; the lookup is what
// verifyAndConsumeRecoveryCode walks (with FOR UPDATE) to find a match.
//
// pending_totp_enrollments stores the encrypted TOTP secret between /enroll
// and /verify-enrollment. Encrypted under slot
// 'pending_totp_enrollments.encrypted_secret'. Verify-enrollment decrypts,
// validates the user's first code, RE-ENCRYPTS under
// 'users.totp_secret' slot (different AAD → different ciphertext) and
// writes the new blob to users.totp_secret. Stale rows expire at 10 min.
//
// auth_challenges is the pre-auth challenge table. /api/user/auth INSERTs
// a row when a TOTP-enabled user passes the Magic-DID check; the response
// returns ONLY the challengeId. /api/user/auth/totp validates the
// challenge read-only, runs factor verification, and on success consumes
// the challenge atomically inside the same transaction that commits the
// user-state reset. The session cookie is issued only after that COMMIT.
// ----------------------------------------------------------------------------
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // The partial unused-only index lives in the SQL migration; Drizzle's
  // index DSL doesn't reliably emit `WHERE` clauses. Same pattern the
  // aa_pending_user_ops table uses for its partial uniqueness.
);

export const pendingTotpEnrollments = pgTable(
  'pending_totp_enrollments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    encryptedSecret: text('encrypted_secret').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    userIdx: index('pending_totp_user_idx').on(t.userId),
    expiresIdx: index('pending_totp_expires_idx').on(t.expiresAt),
  }),
);

export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    magicEoa: text('magic_eoa').notNull(),
    purpose: text('purpose').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    expiresIdx: index('auth_challenges_expires_idx').on(t.expiresAt),
    // The unconsumed partial index lives in the migration.
  }),
);

// ----------------------------------------------------------------------------
// Phase 2B: Private Markets indexer mirror.
//
// Six tables that mirror MakoPrivateMarketsV1 chain state into Postgres so
// the UI can serve fast list / detail / profile queries without round-
// tripping the RPC. The contract is the source of truth — these tables are
// a denormalized read cache plus the slug ↔ marketId correlation surface.
//
// Partial unique indexes (`pm_markets_slug_active_uniq`,
// `pm_markets_client_nonce_pending_uniq`) and CHECK constraints are emitted
// as raw SQL in 0006_private_markets.sql; Drizzle's index DSL doesn't
// reliably emit `WHERE` clauses, same pattern as the AA tables in 0002.
//
// Effective state derivation (`Open`, `AwaitingCreator`, lazy `TimedOut`,
// lazy `ZeroStakeExpired`) is computed by `effectiveState(row, now)` in
// queries.ts — never persisted. `current_state` mirrors only the contract's
// stored, event-driven values.
// ----------------------------------------------------------------------------
export const pmMarkets = pgTable(
  'pm_markets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    slug: text('slug').notNull(),
    clientNonce: varchar('client_nonce', { length: 66 }).notNull(),
    userOpHash: varchar('user_op_hash', { length: 66 }),
    marketId: bigint('market_id', { mode: 'number' }),
    creator: varchar('creator', { length: 42 }).notNull(),
    shape: pmMarketShapeEnum('shape').notNull(),
    createStatus: pmCreateStatusEnum('create_status').notNull().default('pending'),
    pendingAt: timestamp('pending_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    streamUrl: text('stream_url').notNull().default(''),
    visibilityView: integer('visibility_view').notNull(),
    visibilityParticipation: integer('visibility_participation').notNull(),
    stakingOpensAt: timestamp('staking_opens_at', { withTimezone: true }).notNull(),
    closeAt: timestamp('close_at', { withTimezone: true }).notNull(),
    perStakeMin: numeric('per_stake_min', { precision: 78, scale: 0 }).notNull().default('0'),
    perStakeMax: numeric('per_stake_max', { precision: 78, scale: 0 }).notNull().default('0'),
    perWalletCumulativeMax: numeric('per_wallet_cumulative_max', { precision: 78, scale: 0 })
      .notNull()
      .default('0'),
    fixedStake: numeric('fixed_stake', { precision: 78, scale: 0 }).notNull().default('0'),
    winnersCount: integer('winners_count').notNull().default(0),
    currentState: pmMarketStateEnum('current_state').notNull().default('created'),
    friendlyOutcome: integer('friendly_outcome'),
    friendlyEmptyPoolPath: boolean('friendly_empty_pool_path'),
    feeTaken: numeric('fee_taken', { precision: 78, scale: 0 }).notNull().default('0'),
    dust: numeric('dust', { precision: 78, scale: 0 }).notNull().default('0'),
    totalStake: numeric('total_stake', { precision: 78, scale: 0 }).notNull().default('0'),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // All indexes (partial uniques + supporting btrees) live in the SQL
  // migration — see 0006 for the full set.
);

export const pmOptions = pgTable(
  'pm_options',
  {
    marketDbId: uuid('market_db_id')
      .notNull()
      .references(() => pmMarkets.id, { onDelete: 'cascade' }),
    optionIndex: integer('option_index').notNull(),
    label: text('label').notNull(),
    participantWallet: varchar('participant_wallet', { length: 42 }),
    poolTotal: numeric('pool_total', { precision: 78, scale: 0 }).notNull().default('0'),
    firstStakeSequence: integer('first_stake_sequence'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.marketDbId, t.optionIndex] }),
  }),
);

export const pmStakes = pgTable(
  'pm_stakes',
  {
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    txHash: varchar('tx_hash', { length: 66 }).notNull(),
    logIndex: integer('log_index').notNull(),
    marketId: bigint('market_id', { mode: 'number' }).notNull(),
    staker: varchar('staker', { length: 42 }).notNull(),
    optionIndex: integer('option_index').notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txHash, t.logIndex] }),
    marketIdx: index('pm_stakes_market').on(t.chainId, t.contractAddress, t.marketId),
    marketStakerIdx: index('pm_stakes_market_staker').on(
      t.chainId,
      t.contractAddress,
      t.marketId,
      t.staker,
    ),
    stakerIdx: index('pm_stakes_staker').on(t.staker),
    marketOptionIdx: index('pm_stakes_market_option').on(
      t.chainId,
      t.contractAddress,
      t.marketId,
      t.optionIndex,
    ),
  }),
);

export const pmResolutions = pgTable(
  'pm_resolutions',
  {
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    txHash: varchar('tx_hash', { length: 66 }).notNull(),
    logIndex: integer('log_index').notNull(),
    marketId: bigint('market_id', { mode: 'number' }).notNull(),
    eventName: text('event_name').notNull(),
    payload: jsonb('payload').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txHash, t.logIndex] }),
    marketIdx: index('pm_resolutions_market').on(t.chainId, t.contractAddress, t.marketId),
    marketEventIdx: index('pm_resolutions_market_event').on(
      t.chainId,
      t.contractAddress,
      t.marketId,
      t.eventName,
    ),
  }),
);

export const pmClaims = pgTable(
  'pm_claims',
  {
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    txHash: varchar('tx_hash', { length: 66 }).notNull(),
    logIndex: integer('log_index').notNull(),
    marketId: bigint('market_id', { mode: 'number' }).notNull(),
    recipient: varchar('recipient', { length: 42 }).notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txHash, t.logIndex] }),
    marketIdx: index('pm_claims_market').on(t.chainId, t.contractAddress, t.marketId),
    marketRecipientIdx: index('pm_claims_market_recipient').on(
      t.chainId,
      t.contractAddress,
      t.marketId,
      t.recipient,
    ),
    recipientIdx: index('pm_claims_recipient').on(t.recipient),
  }),
);

export const pmIndexerState = pgTable('pm_indexer_state', {
  chainId: integer('chain_id').primaryKey(),
  contractAddress: varchar('contract_address', { length: 42 }).notNull(),
  lastIndexedBlock: bigint('last_indexed_block', { mode: 'number' }).notNull().default(0),
  lastCleanupAt: timestamp('last_cleanup_at', { withTimezone: true }),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ----------------------------------------------------------------------------
// mako_market_outcome_labels — admin-defined display labels for MAKO markets.
//
// `MakoMarketsV4` stores binary outcomes as `Outcome.YES = 1` /
// `Outcome.NO = 2` with no label fields. This table lets admin-curated MAKO
// markets show custom labels (e.g. "APC" / "PDP") without a contract
// redeploy. Labels are display-only; the 1/2 outcome stays the contract
// source of truth.
//
// CHECK constraints (octet_length 1..32 per label) live in the SQL migration
// at 0007; schema here mirrors only the column shape.
// ----------------------------------------------------------------------------
export const makoMarketOutcomeLabels = pgTable('mako_market_outcome_labels', {
  marketId: bigint('market_id', { mode: 'number' }).primaryKey(),
  label1: text('label_1').notNull(),
  label2: text('label_2').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ----------------------------------------------------------------------------
// #186 Leaderboard — main-market event ledger.
//
// Two tables that mirror the MAIN MakoMarketsV4 contract's per-user events
// (BetPlaced / Claimed / CreatorFeePaid) into Postgres so /api/leaderboard
// can aggregate Net PnL without enumerating bettors on-chain (impossible:
// `getUserBet` needs an address input). Raw event rows, aggregated at read
// time — NOT running per-address aggregates — so weekly windowing is a
// timestamp filter and re-ingest is idempotent by construction.
//
// Invariants (CHECK constraints live in 0008, Drizzle mirrors column shape
// only, same pattern as 0006/0007):
//   - actor / contract_address / tx_hash stored LOWERCASE (ingest
//     normalizes; the DB enforces). The identity join in
//     src/lib/leaderboard/identity.ts must still lower() its own side —
//     user_safes.safe_address is stored CHECKSUMMED (safe.ts:154).
//   - kind ∈ ('bet','claim','creator_fee'). Text + CHECK, not a pg enum:
//     the v2 win% metric adds kind='resolution' by swapping one
//     constraint instead of altering an enum type.
//   - is_yes is NOT NULL exactly when kind='bet'.
//   - PK (tx_hash, log_index) — repo precedent (pm_stakes / pm_claims);
//     strictly stronger than the (contract, tx, log) uniqueness the
//     reorg/idempotency model requires.
//   - market_id is TEXT (uint256-safe), unlike mako_market_outcome_labels'
//     bigint — the ledger only groups/equates on it, never arithmetic;
//     cast at the join if the two are ever correlated.
//
// Reorg safety comes from the indexer's CONFIRMATIONS horizon, NOT from
// the PK — there is deliberately no deletion path (see
// src/lib/leaderboard/indexer.ts).
// ----------------------------------------------------------------------------
export type MakoMarketEventKind = 'bet' | 'claim' | 'creator_fee';

export const makoMarketEvents = pgTable(
  'mako_market_events',
  {
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    version: text('version').notNull(),
    marketId: text('market_id').notNull(),
    kind: text('kind').$type<MakoMarketEventKind>().notNull(),
    actor: varchar('actor', { length: 42 }).notNull(),
    isYes: boolean('is_yes'),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),
    txHash: varchar('tx_hash', { length: 66 }).notNull(),
    logIndex: integer('log_index').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txHash, t.logIndex] }),
    actorIdx: index('mako_market_events_actor').on(t.actor),
    kindIdx: index('mako_market_events_kind').on(t.kind),
    timestampIdx: index('mako_market_events_block_timestamp').on(t.blockTimestamp),
    contractIdx: index('mako_market_events_contract').on(t.chainId, t.contractAddress),
  }),
);

// One cursor row per (chain, contract) in LEADERBOARD_CONTRACTS. The
// indexer scans (last_scanned_block, head − CONFIRMATIONS] in chunks;
// each chunk's event inserts + cursor advance commit in one transaction.
// locked_at is the worker lock (stale-recovery threshold MUST exceed the
// cron route's maxDuration — see the constant-relationship test).
export const makoLeaderboardIndexerState = pgTable(
  'mako_leaderboard_indexer_state',
  {
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    lastScannedBlock: bigint('last_scanned_block', { mode: 'number' }).notNull().default(0),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chainId, t.contractAddress] }),
  }),
);

// ----------------------------------------------------------------------------
// Convenience type exports for application code. Drizzle derives insert/select
// row types from the table declaration, which is what callers should import.
// ----------------------------------------------------------------------------
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSafe = typeof userSafes.$inferSelect;
export type NewUserSafe = typeof userSafes.$inferInsert;
export type AllowlistEmail = typeof allowlistEmails.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type FiatPayment = typeof fiatPayments.$inferSelect;
export type NewFiatPayment = typeof fiatPayments.$inferInsert;
export type Deposit = typeof deposits.$inferSelect;
export type NewDeposit = typeof deposits.$inferInsert;
export type Bridge = typeof bridges.$inferSelect;
export type NewBridge = typeof bridges.$inferInsert;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type NewWithdrawal = typeof withdrawals.$inferInsert;
export type KycRecord = typeof kycRecords.$inferSelect;
export type ProviderWebhook = typeof providerWebhooks.$inferSelect;
export type ChainState = typeof chainState.$inferSelect;
export type AaPendingUserOp = typeof aaPendingUserOps.$inferSelect;
export type NewAaPendingUserOp = typeof aaPendingUserOps.$inferInsert;
export type AaPendingStatus = AaPendingUserOp['status'];
export type AaSponsorLimit = typeof aaSponsorLimits.$inferSelect;
export type RecoveryCode = typeof recoveryCodes.$inferSelect;
export type NewRecoveryCode = typeof recoveryCodes.$inferInsert;
export type PendingTotpEnrollment = typeof pendingTotpEnrollments.$inferSelect;
export type NewPendingTotpEnrollment = typeof pendingTotpEnrollments.$inferInsert;
export type AuthChallenge = typeof authChallenges.$inferSelect;
export type NewAuthChallenge = typeof authChallenges.$inferInsert;
export type PmMarket = typeof pmMarkets.$inferSelect;
export type NewPmMarket = typeof pmMarkets.$inferInsert;
export type PmMarketShape = PmMarket['shape'];
export type PmMarketState = PmMarket['currentState'];
export type PmCreateStatus = PmMarket['createStatus'];
export type PmOption = typeof pmOptions.$inferSelect;
export type NewPmOption = typeof pmOptions.$inferInsert;
export type PmStake = typeof pmStakes.$inferSelect;
export type NewPmStake = typeof pmStakes.$inferInsert;
export type PmResolution = typeof pmResolutions.$inferSelect;
export type NewPmResolution = typeof pmResolutions.$inferInsert;
export type PmClaim = typeof pmClaims.$inferSelect;
export type NewPmClaim = typeof pmClaims.$inferInsert;
export type PmIndexerState = typeof pmIndexerState.$inferSelect;
export type NewPmIndexerState = typeof pmIndexerState.$inferInsert;
export type MakoMarketOutcomeLabel = typeof makoMarketOutcomeLabels.$inferSelect;
export type NewMakoMarketOutcomeLabel = typeof makoMarketOutcomeLabels.$inferInsert;
export type MakoMarketEvent = typeof makoMarketEvents.$inferSelect;
export type NewMakoMarketEvent = typeof makoMarketEvents.$inferInsert;
export type MakoLeaderboardIndexerState = typeof makoLeaderboardIndexerState.$inferSelect;
export type NewMakoLeaderboardIndexerState = typeof makoLeaderboardIndexerState.$inferInsert;
