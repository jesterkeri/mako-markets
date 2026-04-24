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
  integer,
  bigint,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  numeric,
} from 'drizzle-orm/pg-core';

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

// ----------------------------------------------------------------------------
// users — source of truth: this DB. One row per Magic account.
// ----------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  magicEoa: text('magic_eoa').notNull(),
  kycStatus: kycStatusEnum('kyc_status').notNull().default('none'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
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
// sessions — HMAC session cookie state. Pattern adapted from admin-session.ts.
// hmacToken is the full signed cookie value; the `id` field lets us revoke a
// single session without invalidating every other session the user has open.
// ----------------------------------------------------------------------------
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  hmacToken: text('hmac_token').notNull(),
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
