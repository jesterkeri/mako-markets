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

import { pmMarkets, pmOptions } from '@/db/schema';
import {
  getMarketBySlug,
  getMarketByMarketId,
  getMarketBySlugIncludingHistory,
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
