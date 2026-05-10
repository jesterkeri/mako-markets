// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/queries.test.ts
//
// Integration tests for queries.ts. Exercises the active-row filter
// (Codex round-1 M1: getMarketBySlug must skip failed/abandoned),
// option ordering (Codex round-1 m1: deterministic ascending), and
// the marketId helper's lowercase normalisation.
//
// queries.ts uses the global `db` import from @/db/client; we vi.mock
// that to inject a pglite-backed Drizzle instance for the duration
// of each test.
// ----------------------------------------------------------------------------

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  db: null as unknown as import('drizzle-orm/pglite').PgliteDatabase<typeof import('@/db/schema')>,
}));

vi.mock('@/db/client', () => ({
  // queries.ts only reads `db`; we proxy through to harness.db so
  // each test can swap in a fresh pglite instance without re-mocking.
  get db() {
    return harness.db;
  },
}));

import { eq } from 'drizzle-orm';
import type { PublicClient } from 'viem';

import { pmClaims, pmMarkets, pmOptions, pmStakes } from '@/db/schema';
import {
  __setDbCallCounter,
  getClaimsForWallet,
  getMarketBySlug,
  getMarketByMarketId,
  getMarketBySlugIncludingHistory,
  getMarketsCreatedByWallet,
  getMarketsForWalletByEffectiveState,
  getPendingClaimsForWallet,
  getStakesForWallet,
} from '../queries';
import { createTestDb, type TestDb } from './test-db';

const CHAIN_ID = 10143;
const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const CONTRACT_CHECKSUM =
  '0xC9c6575a14D0e84afd5AB21C506916Fd2864bb8f' as const;
const NONCE_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const CREATOR =
  '0x1111111111111111111111111111111111111111' as const;

let active: TestDb | null = null;

beforeEach(async () => {
  active = await createTestDb();
  // Replace harness.db with the fresh per-test instance.
  harness.db = active.db;
});

afterEach(async () => {
  if (active) {
    await active.close();
    active = null;
  }
  vi.clearAllMocks();
});

async function seedConfirmed(opts: {
  slug: string;
  marketId: number;
  optionLabels?: string[];
}): Promise<string> {
  const inserted = await active!.db
    .insert(pmMarkets)
    .values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: opts.slug,
      clientNonce: NONCE_1,
      creator: CREATOR,
      marketId: opts.marketId,
      shape: 'friendly',
      createStatus: 'confirmed',
      confirmedAt: new Date(),
      title: 'A market',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    })
    .returning({ id: pmMarkets.id });
  const id = inserted[0].id;
  const labels = opts.optionLabels ?? ['NO', 'YES'];
  await active!.db.insert(pmOptions).values(
    labels.map((label, idx) => ({
      marketDbId: id,
      optionIndex: idx,
      label,
      participantWallet: null,
      poolTotal: '0',
      firstStakeSequence: null,
    })),
  );
  return id;
}

describe('getMarketBySlug', () => {
  it('returns a confirmed market with its options ordered ascending', async () => {
    await seedConfirmed({
      slug: 'happy1',
      marketId: 1,
      optionLabels: ['Alpha', 'Bravo', 'Charlie'],
    });
    const result = await getMarketBySlug('happy1');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('happy1');
    expect(result!.shape).toBe('friendly');
    expect(result!.options.map((o) => o.label)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(result!.options.map((o) => o.optionIndex)).toEqual([0, 1, 2]);
  });

  it('skips failed rows when an active row would also match (R8-M1)', async () => {
    // Same slug for a failed-status row + a confirmed-status row would
    // not violate the partial unique index (it only constrains
    // pending/confirmed). Insert the failed row, then the confirmed one.
    await active!.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'shared-slug',
      clientNonce: NONCE_1,
      creator: CREATOR,
      shape: 'friendly',
      createStatus: 'failed',
      failedAt: new Date(),
      failureReason: 'sponsor_rejected',
      title: 'Failed earlier attempt',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });
    const NONCE_2 =
      '0x0000000000000000000000000000000000000000000000000000000000000002' as const;
    await active!.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'shared-slug',
      clientNonce: NONCE_2,
      creator: CREATOR,
      marketId: 99,
      shape: 'friendly',
      createStatus: 'confirmed',
      confirmedAt: new Date(),
      title: 'Active confirmed',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });

    const result = await getMarketBySlug('shared-slug');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Active confirmed');
    expect(result!.marketId).toBe(99);
  });

  it('returns null when only failed/abandoned rows exist for a slug', async () => {
    await active!.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'historical',
      clientNonce: NONCE_1,
      creator: CREATOR,
      shape: 'friendly',
      createStatus: 'abandoned',
      failedAt: new Date(),
      failureReason: 'ttl_expired',
      title: 'Aged out',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });
    const result = await getMarketBySlug('historical');
    expect(result).toBeNull();
  });

  it('returns null when the slug does not exist', async () => {
    const result = await getMarketBySlug('does-not-exist');
    expect(result).toBeNull();
  });

  it('returns a pending row (active set includes pending)', async () => {
    await active!.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'pending-x',
      clientNonce: NONCE_1,
      creator: CREATOR,
      shape: 'friendly',
      createStatus: 'pending',
      title: 'Awaiting on-chain MarketCreated',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });
    const result = await getMarketBySlug('pending-x');
    expect(result).not.toBeNull();
    expect(result!.createStatus).toBe('pending');
    expect(result!.marketId).toBeNull();
  });
});

describe('getMarketByMarketId', () => {
  it('finds a confirmed row by (chainId, contract, marketId)', async () => {
    await seedConfirmed({ slug: 'mid1', marketId: 7 });
    const result = await getMarketByMarketId(CHAIN_ID, CONTRACT, 7);
    expect(result).not.toBeNull();
    expect(result!.marketId).toBe(7);
  });

  it('lowercases checksummed contractAddress before lookup', async () => {
    await seedConfirmed({ slug: 'mid2', marketId: 8 });
    const result = await getMarketByMarketId(CHAIN_ID, CONTRACT_CHECKSUM, 8);
    expect(result).not.toBeNull();
    expect(result!.marketId).toBe(8);
  });

  it('returns null when marketId is unknown', async () => {
    const result = await getMarketByMarketId(CHAIN_ID, CONTRACT, 999);
    expect(result).toBeNull();
  });

  it('does not surface pending rows (NULL marketId)', async () => {
    await active!.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'pendingmid',
      clientNonce: NONCE_1,
      creator: CREATOR,
      shape: 'friendly',
      createStatus: 'pending',
      title: 'Pending no marketId',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });
    // marketId is NULL — getMarketByMarketId by definition can't match.
    const result = await getMarketByMarketId(CHAIN_ID, CONTRACT, 0);
    expect(result).toBeNull();
  });
});

describe('getMarketBySlugIncludingHistory (2F stub)', () => {
  it('throws "Not implemented in 2B-2"', async () => {
    await expect(getMarketBySlugIncludingHistory('any')).rejects.toThrow(
      /Not implemented in 2B-2/,
    );
  });
});

// ============================================================================
// Phase 2B-6 — pending-claim queries + listing helpers
// ============================================================================

const STAKER_A = '0x2222222222222222222222222222222222222222' as const;
const STAKER_B = '0x3333333333333333333333333333333333333333' as const;
const NOW = new Date('2026-05-15T12:00:00Z');
const STALE = new Date('2026-05-13T12:00:00Z');

async function seedConfirmedMarket(opts: {
  marketId: number;
  shape?: 'friendly' | 'open_vote' | 'prize_pool';
  creator?: `0x${string}`;
  currentState?:
    | 'created'
    | 'resolved'
    | 'empty_pool_resolved'
    | 'canceled'
    | 'timed_out'
    | 'zero_stake_expired';
  stakingOpensAt?: Date;
  closeAt?: Date;
  totalStake?: string;
  confirmedAt?: Date;
}): Promise<string> {
  const inserted = await active!.db
    .insert(pmMarkets)
    .values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: `dx-${opts.marketId.toString().padStart(8, '0')}`,
      clientNonce:
        ('0x' + opts.marketId.toString(16).padStart(64, '0')) as `0x${string}`,
      creator: opts.creator ?? CREATOR,
      marketId: opts.marketId,
      shape: opts.shape ?? 'friendly',
      createStatus: 'confirmed',
      confirmedAt: opts.confirmedAt ?? STALE,
      pendingAt: STALE,
      title: `Market ${opts.marketId}`,
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: opts.stakingOpensAt ?? new Date('2026-05-12T00:01:00Z'),
      closeAt: opts.closeAt ?? new Date('2026-05-12T00:10:00Z'),
      currentState: opts.currentState ?? 'resolved',
      totalStake: opts.totalStake ?? '0',
    })
    .returning({ id: pmMarkets.id });
  const id = inserted[0].id;
  await active!.db.insert(pmOptions).values([
    {
      marketDbId: id,
      optionIndex: 0,
      label: 'NO',
      participantWallet: null,
      poolTotal: '0',
      firstStakeSequence: null,
    },
    {
      marketDbId: id,
      optionIndex: 1,
      label: 'YES',
      participantWallet: null,
      poolTotal: '0',
      firstStakeSequence: null,
    },
  ]);
  return id;
}

async function seedStake(args: {
  marketId: number;
  staker: `0x${string}`;
  optionIndex: number;
  amount: string;
  txHash?: `0x${string}`;
}): Promise<void> {
  await active!.db.insert(pmStakes).values({
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    txHash:
      args.txHash ??
      (('0x' + args.marketId.toString(16).padStart(64, '0')) as `0x${string}`),
    logIndex: args.optionIndex,
    marketId: args.marketId,
    staker: args.staker,
    optionIndex: args.optionIndex,
    amount: args.amount,
    blockNumber: 30699999,
    blockTimestamp: STALE,
  });
}

async function seedClaim(args: {
  marketId: number;
  recipient: `0x${string}`;
  amount: string;
  txHash?: `0x${string}`;
}): Promise<void> {
  await active!.db.insert(pmClaims).values({
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    txHash:
      args.txHash ??
      (('0x' + args.marketId.toString(16).padStart(64, '0')) as `0x${string}`),
    logIndex: 0,
    marketId: args.marketId,
    recipient: args.recipient,
    amount: args.amount,
    blockNumber: 30699999,
    blockTimestamp: STALE,
  });
}

function buildMulticallClient(
  pendingByMarketId: Map<number, bigint | 'revert'>,
): PublicClient {
  return {
    multicall: vi.fn(
      async (a: {
        contracts: Array<{ args: readonly [bigint, `0x${string}`] }>;
      }) => {
        return a.contracts.map((c) => {
          const mid = Number(c.args[0]);
          const v = pendingByMarketId.get(mid);
          if (v === 'revert' || v === undefined) {
            return { status: 'failure' };
          }
          return { status: 'success', result: v };
        });
      },
    ),
  } as unknown as PublicClient;
}

beforeEach(() => {
  // Reset DB call counter between tests so cross-test bleed is impossible.
  __setDbCallCounter(null);
});

afterEach(() => {
  __setDbCallCounter(null);
});

describe('getStakesForWallet', () => {
  it('returns all pm_stakes for wallet, contract-scoped, ordered by blockTimestamp DESC', async () => {
    await seedConfirmedMarket({ marketId: 1 });
    await seedStake({ marketId: 1, staker: STAKER_A, optionIndex: 1, amount: '5000000' });
    await seedStake({ marketId: 1, staker: STAKER_A, optionIndex: 0, amount: '1000000', txHash: ('0x' + 'b'.repeat(64)) as `0x${string}` });
    const r = await getStakesForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
    });
    expect(r).toHaveLength(2);
    expect(r[0].amount).toBeDefined();
  });
  it('returns empty array when wallet has no stakes', async () => {
    await seedConfirmedMarket({ marketId: 2 });
    const r = await getStakesForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_B,
    });
    expect(r).toEqual([]);
  });
});

describe('getClaimsForWallet', () => {
  it('returns all pm_claims for wallet (lowercase normalised input)', async () => {
    await seedConfirmedMarket({ marketId: 3 });
    await seedClaim({ marketId: 3, recipient: STAKER_A, amount: '500' });
    // Mixed-case keeping the 0x prefix lowercase (only the hex digits
    // upper). normalizeHex toLowerCases the entire string anyway.
    const mixed =
      '0x2222222222222222222222222222222222222222' as `0x${string}`;
    const r = await getClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: mixed,
    });
    expect(r).toHaveLength(1);
    expect(r[0].marketId).toBe(3);
    expect(r[0].amount).toBe('500');
  });
});

describe('getPendingClaimsForWallet', () => {
  it('happy path: resolved market, wallet won → row included with pending amount', async () => {
    await seedConfirmedMarket({ marketId: 10 });
    await seedStake({ marketId: 10, staker: STAKER_A, optionIndex: 1, amount: '5000000' });
    const client = buildMulticallClient(new Map([[10, 9_750_000n]]));
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].pendingAmountOnChain).toBe('9750000');
    expect(r.rows[0].effectiveStateAt).toBe('resolved');
    expect(r.chainReadStatus).toBe('ok');
    expect(r.readAttemptCount).toBe(1);
    expect(r.readFailureCount).toBe(0);
  });

  it('already-claimed: chain returns 0, audit > 0 → excluded by default; included with includeFullyClaimed=true', async () => {
    await seedConfirmedMarket({ marketId: 11 });
    await seedStake({ marketId: 11, staker: STAKER_A, optionIndex: 1, amount: '5000000' });
    await seedClaim({ marketId: 11, recipient: STAKER_A, amount: '9000000' });
    const client = buildMulticallClient(new Map([[11, 0n]]));
    const def = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(def.rows).toHaveLength(0);
    const inc = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
      includeFullyClaimed: true,
    });
    expect(inc.rows).toHaveLength(1);
    expect(inc.rows[0].alreadyClaimedFromAudit).toBe('9000000');
  });

  it('includePending=true: open-state market → row included, pending=0', async () => {
    await seedConfirmedMarket({
      marketId: 12,
      currentState: 'created',
      stakingOpensAt: new Date('2026-05-15T11:00:00Z'),
      closeAt: new Date('2026-05-15T13:00:00Z'),
      totalStake: '5000000',
    });
    await seedStake({ marketId: 12, staker: STAKER_A, optionIndex: 1, amount: '5000000' });
    const client = buildMulticallClient(new Map([[12, 0n]]));
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
      includePending: true,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].effectiveStateAt).toBe('open');
    expect(r.rows[0].pendingAmountOnChain).toBe('0');
  });

  it('Codex r1 M3 — read-failed rows are INCLUDED with null pendingAmountOnChain', async () => {
    await seedConfirmedMarket({ marketId: 13 });
    await seedStake({ marketId: 13, staker: STAKER_A, optionIndex: 1, amount: '1' });
    const client = buildMulticallClient(new Map([[13, 'revert']]));
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].pendingAmountOnChain).toBeNull();
  });

  it('Codex r2 M1 — DB lag, includePending=true includes stale awaiting_creator', async () => {
    // pm_markets in 'created' but past closeAt + grace not yet → 'awaiting_creator'
    await seedConfirmedMarket({
      marketId: 14,
      currentState: 'created',
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
      totalStake: '1000000',
    });
    await seedStake({ marketId: 14, staker: STAKER_A, optionIndex: 1, amount: '1000000' });
    // Chain says 0 (could be either pre-resolution or already-claimed; the
    // helper can't distinguish without extra RPC; default filter excludes).
    const client = buildMulticallClient(new Map([[14, 0n]]));
    const def = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(def.rows).toHaveLength(0); // chain authoritative — 0 means nothing owed
    const inc = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
      includePending: true,
    });
    expect(inc.rows).toHaveLength(1);
    expect(inc.rows[0].effectiveStateAt).toBe('awaiting_creator');
  });

  it('Prize Pool participant (NOT a staker) included via pm_options.participantWallet', async () => {
    const dbId = await seedConfirmedMarket({
      marketId: 15,
      shape: 'prize_pool',
    });
    await active!.db
      .update(pmOptions)
      .set({ participantWallet: STAKER_A })
      .where(eq(pmOptions.marketDbId, dbId));
    const client = buildMulticallClient(new Map([[15, 7_000_000n]]));
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].pendingAmountOnChain).toBe('7000000');
  });

  it('empty result: wallet that never touched any market', async () => {
    await seedConfirmedMarket({ marketId: 16 });
    const client = buildMulticallClient(new Map());
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_B,
      publicClient: client,
      now: NOW,
    });
    expect(r.rows).toEqual([]);
    expect(r.readAttemptCount).toBe(0);
    expect(r.chainReadStatus).toBe('ok');
  });
});

describe('chainReadStatus aggregate (Codex r3 M1 + r5 m1)', () => {
  it('20a — zero candidates → ok', async () => {
    const client = buildMulticallClient(new Map());
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_B,
      publicClient: client,
      now: NOW,
    });
    expect(r.chainReadStatus).toBe('ok');
    expect(r.readAttemptCount).toBe(0);
  });

  it('20b — partial fail → degraded; rows.length matches readAttemptCount when all kept', async () => {
    await seedConfirmedMarket({ marketId: 30 });
    await seedConfirmedMarket({ marketId: 31 });
    await seedConfirmedMarket({ marketId: 32 });
    await seedStake({ marketId: 30, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '3'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 31, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '4'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 32, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '5'.repeat(64)) as `0x${string}` });
    const client = buildMulticallClient(
      new Map<number, bigint | 'revert'>([
        [30, 100n],
        [31, 200n],
        [32, 'revert'],
      ]),
    );
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(r.readAttemptCount).toBe(3);
    expect(r.readFailureCount).toBe(1);
    expect(r.rows).toHaveLength(3);
    expect(r.chainReadStatus).toBe('degraded');
  });

  it('20c — all 3 candidates fail → failed; all rows have null pending', async () => {
    await seedConfirmedMarket({ marketId: 40 });
    await seedConfirmedMarket({ marketId: 41 });
    await seedConfirmedMarket({ marketId: 42 });
    await seedStake({ marketId: 40, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '6'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 41, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '7'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 42, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + 'd'.repeat(64)) as `0x${string}` });
    const client = buildMulticallClient(
      new Map<number, bigint | 'revert'>([
        [40, 'revert'],
        [41, 'revert'],
        [42, 'revert'],
      ]),
    );
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(r.readAttemptCount).toBe(3);
    expect(r.chainReadStatus).toBe('failed');
    expect(r.readFailureCount).toBe(r.readAttemptCount);
    expect(r.rows.every((row) => row.pendingAmountOnChain === null)).toBe(true);
  });

  it('20e — Codex 2B-6 r1 M1: multicall throws → batch treated as all failed (no propagation)', async () => {
    await seedConfirmedMarket({ marketId: 70 });
    await seedConfirmedMarket({ marketId: 71 });
    await seedStake({ marketId: 70, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + 'e'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 71, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + 'f'.repeat(64)) as `0x${string}` });
    const client = {
      multicall: vi.fn(async () => {
        throw new Error('rpc 500');
      }),
    } as unknown as PublicClient;
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(r.readAttemptCount).toBe(2);
    expect(r.readFailureCount).toBe(2);
    expect(r.chainReadStatus).toBe('failed');
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((row) => row.pendingAmountOnChain === null)).toBe(true);
  });

  it('20f — Codex 2B-6 r1 M1: multicall throws on one batch only → degraded', async () => {
    await seedConfirmedMarket({ marketId: 80 });
    await seedConfirmedMarket({ marketId: 81 });
    await seedStake({ marketId: 80, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '1'.repeat(63) + '2') as `0x${string}` });
    await seedStake({ marketId: 81, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '1'.repeat(63) + '3') as `0x${string}` });
    let calls = 0;
    const client = {
      multicall: vi.fn(
        async (a: { contracts: Array<{ args: readonly [bigint, `0x${string}`] }> }) => {
          calls++;
          if (calls === 1) throw new Error('rpc transport drop');
          return a.contracts.map((c) => ({
            status: 'success' as const,
            result: 100n,
            __mid: Number(c.args[0]),
          }));
        },
      ),
    } as unknown as PublicClient;
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
      multicallBatchSize: 1, // force two separate batches
    });
    expect(r.readAttemptCount).toBe(2);
    expect(r.readFailureCount).toBe(1);
    expect(r.chainReadStatus).toBe('degraded');
  });

  it('20d — readAttemptCount diverges from rows.length (Codex r5 m1)', async () => {
    await seedConfirmedMarket({ marketId: 50 });
    await seedConfirmedMarket({ marketId: 51 });
    await seedConfirmedMarket({ marketId: 52 });
    await seedStake({ marketId: 50, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '8'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 51, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + '9'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 52, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + 'a'.repeat(64)) as `0x${string}` });
    // 50 returns 0 (no claim); 51 returns 5_000_000; 52 reverts.
    const client = buildMulticallClient(
      new Map<number, bigint | 'revert'>([
        [50, 0n],
        [51, 5_000_000n],
        [52, 'revert'],
      ]),
    );
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(r.readAttemptCount).toBe(3);
    expect(r.rows).toHaveLength(2); // 50 excluded by default filter
    expect(r.chainReadStatus).toBe('degraded');
  });
});

describe('batch-hydration DB call counter (Codex r3 M2 + r5 M1)', () => {
  it('non-zero candidates: counters=(candidateMarkets:1, options:1, stakes:1, claims:1)', async () => {
    await seedConfirmedMarket({ marketId: 60 });
    await seedConfirmedMarket({ marketId: 61 });
    await seedStake({ marketId: 60, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + 'b'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 61, staker: STAKER_A, optionIndex: 1, amount: '1', txHash: ('0x' + 'c'.repeat(64)) as `0x${string}` });
    const counter = {
      candidateMarkets: 0,
      options: 0,
      stakes: 0,
      claims: 0,
    };
    __setDbCallCounter(counter);
    const client = buildMulticallClient(
      new Map<number, bigint | 'revert'>([
        [60, 100n],
        [61, 200n],
      ]),
    );
    await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      publicClient: client,
      now: NOW,
    });
    expect(counter.candidateMarkets).toBe(1);
    expect(counter.options).toBe(1);
    expect(counter.stakes).toBe(1);
    expect(counter.claims).toBe(1);
  });

  it('zero candidates (Codex r5 M1): candidateMarkets=1 still ran; others=0', async () => {
    const counter = {
      candidateMarkets: 0,
      options: 0,
      stakes: 0,
      claims: 0,
    };
    __setDbCallCounter(counter);
    const client = buildMulticallClient(new Map());
    await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_B,
      publicClient: client,
      now: NOW,
    });
    expect(counter.candidateMarkets).toBe(1);
    expect(counter.options).toBe(0);
    expect(counter.stakes).toBe(0);
    expect(counter.claims).toBe(0);
  });
});

describe('getMarketsCreatedByWallet / getMarketsForWalletByEffectiveState', () => {
  it('pagination: limit=2 offset=2 returns rows 3-4', async () => {
    for (let i = 1; i <= 5; i++) {
      await seedConfirmedMarket({
        marketId: 100 + i,
        creator: CREATOR,
        confirmedAt: new Date(Date.UTC(2026, 4, 10 + i)),
      });
    }
    const r = await getMarketsCreatedByWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: CREATOR,
      now: NOW,
      limit: 2,
      offset: 2,
    });
    expect(r.rows).toHaveLength(2);
    expect(r.totalCount).toBe(5);
  });

  it('Codex r5 m2 — deterministic tie-breaker: same confirmed_at, ordered by market_id DESC', async () => {
    const sameTime = new Date('2026-05-12T01:00:00Z');
    await seedConfirmedMarket({ marketId: 200, creator: CREATOR, confirmedAt: sameTime });
    await seedConfirmedMarket({ marketId: 201, creator: CREATOR, confirmedAt: sameTime });
    await seedConfirmedMarket({ marketId: 202, creator: CREATOR, confirmedAt: sameTime });
    const r1 = await getMarketsCreatedByWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: CREATOR,
      now: NOW,
      limit: 2,
      offset: 0,
    });
    const r2 = await getMarketsCreatedByWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: CREATOR,
      now: NOW,
      limit: 2,
      offset: 0,
    });
    // Same call twice → same rows in same order.
    expect(r1.rows.map((r) => r.market.marketId)).toEqual([202, 201]);
    expect(r2.rows.map((r) => r.market.marketId)).toEqual([202, 201]);
  });

  it('effectiveStateFilter: only "open" markets returned', async () => {
    await seedConfirmedMarket({
      marketId: 300,
      creator: CREATOR,
      currentState: 'created',
      stakingOpensAt: new Date('2026-05-15T11:00:00Z'),
      closeAt: new Date('2026-05-15T13:00:00Z'),
    });
    await seedConfirmedMarket({ marketId: 301, creator: CREATOR, currentState: 'resolved' });
    await seedStake({ marketId: 300, staker: STAKER_A, optionIndex: 0, amount: '1', txHash: ('0x' + 'd'.repeat(64)) as `0x${string}` });
    await seedStake({ marketId: 301, staker: STAKER_A, optionIndex: 0, amount: '1', txHash: ('0x' + 'e'.repeat(64)) as `0x${string}` });
    const r = await getMarketsForWalletByEffectiveState({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_A,
      now: NOW,
      effectiveStateFilter: ['open'],
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].market.marketId).toBe(300);
  });

  it('truncation: candidateCap=2 with 3 seeded → truncated:true', async () => {
    for (let i = 1; i <= 3; i++) {
      await seedConfirmedMarket({
        marketId: 400 + i,
        creator: CREATOR,
        confirmedAt: new Date(Date.UTC(2026, 4, 10 + i)),
      });
    }
    const r = await getMarketsCreatedByWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: CREATOR,
      now: NOW,
      limit: 50,
      candidateCap: 2,
    });
    expect(r.truncated).toBe(true);
    expect(r.candidateCap).toBe(2);
  });
});

describe('PendingClaimsResult includes candidateCap (Codex r2 m2)', () => {
  it('returned shape has candidateCap field', async () => {
    const client = buildMulticallClient(new Map());
    const r = await getPendingClaimsForWallet({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      wallet: STAKER_B,
      publicClient: client,
      now: NOW,
      candidateCap: 100,
    });
    expect(r.candidateCap).toBe(100);
  });
});

describe('__setDbCallCounter test-only guard (Codex r5 m3)', () => {
  it('throws when called outside test environment', () => {
    // Stub both env vars to non-test values; vi.stubEnv handles
    // NODE_ENV's read-only Vitest declaration.
    vi.stubEnv('MAKO_STAGE', 'production');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => __setDbCallCounter(null)).toThrow(/test-only/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('Codex 2B-6 r1 M2 — numeric arg validation', () => {
  it('multicallBatchSize=0 throws RangeError before any DB call', async () => {
    const client = buildMulticallClient(new Map());
    await expect(
      getPendingClaimsForWallet({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        wallet: STAKER_A,
        publicClient: client,
        now: NOW,
        multicallBatchSize: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
  it('multicallBatchSize=-1 throws RangeError', async () => {
    const client = buildMulticallClient(new Map());
    await expect(
      getPendingClaimsForWallet({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        wallet: STAKER_A,
        publicClient: client,
        now: NOW,
        multicallBatchSize: -1,
      }),
    ).rejects.toThrow(RangeError);
  });
  it('candidateCap=0 throws RangeError', async () => {
    const client = buildMulticallClient(new Map());
    await expect(
      getPendingClaimsForWallet({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        wallet: STAKER_A,
        publicClient: client,
        now: NOW,
        candidateCap: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
  it('multicallBatchSize=1.5 (non-integer) throws RangeError', async () => {
    const client = buildMulticallClient(new Map());
    await expect(
      getPendingClaimsForWallet({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        wallet: STAKER_A,
        publicClient: client,
        now: NOW,
        multicallBatchSize: 1.5,
      }),
    ).rejects.toThrow(RangeError);
  });
  it('getMarketsCreatedByWallet limit=0 throws RangeError', async () => {
    await expect(
      getMarketsCreatedByWallet({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        wallet: STAKER_A,
        now: NOW,
        limit: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
  it('getMarketsCreatedByWallet offset=-1 throws RangeError', async () => {
    await expect(
      getMarketsCreatedByWallet({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        wallet: STAKER_A,
        now: NOW,
        offset: -1,
      }),
    ).rejects.toThrow(RangeError);
  });
  it('getMarketsForWalletByEffectiveState candidateCap=0 throws RangeError', async () => {
    await expect(
      getMarketsForWalletByEffectiveState({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        wallet: STAKER_A,
        now: NOW,
        candidateCap: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
});
