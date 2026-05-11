// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/sponsor-gate.test.ts
//
// pglite-backed integration tests for assertPmSponsorDraft. Real SQL
// semantics matter here:
//   - FOR UPDATE behaviour
//   - case-insensitive address comparison
//   - filter by create_status='pending' (a 'failed' or 'confirmed' row
//     must NOT satisfy the lookup)
//
// `@/db/client`'s module-level `db` is mocked to a pglite-backed
// drizzle handle. The helper opens its own db.transaction internally,
// so the mock must expose `.transaction` — pglite-drizzle does.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { pmMarkets } from '@/db/schema';
import { createTestDb, type TestDb } from './test-db';

let active: TestDb | null = null;

vi.mock('@/db/client', () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        if (!active) {
          throw new Error('test-db not initialised — beforeEach missed');
        }
        // Forward EVERY drizzle method (select, insert, update,
        // transaction, execute, ...) to the active pglite drizzle
        // handle. Proxy is the cleanest way to keep references
        // working across the test lifecycle's beforeEach reset.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = (active.db as any)[prop];
        return typeof v === 'function' ? v.bind(active.db) : v;
      },
    },
  ),
}));

// Import AFTER vi.mock so the helper picks up the mocked module.
const { assertPmSponsorDraft } = await import('../sponsor-gate');

const CHAIN_ID = 10143;
const CONTRACT_A = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const SESSION_A = '0x1111111111111111111111111111111111111111' as const;
const SESSION_B = '0x2222222222222222222222222222222222222222' as const;
const NONCE_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const NONCE_UPPER =
  '0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789' as const;

beforeEach(async () => {
  active = await createTestDb();
});

afterEach(async () => {
  if (active) {
    await active.close();
    active = null;
  }
  vi.restoreAllMocks();
});

/// Insert a pending row directly via SQL (mirrors allocatePmDraft's
/// shape but bypasses the slug-allocation overhead since these tests
/// don't care about slug uniqueness).
async function seedPending(args: {
  slug: string;
  clientNonce: `0x${string}`;
  creator: `0x${string}`;
  shape: 'friendly' | 'open_vote' | 'prize_pool';
}): Promise<string> {
  if (!active) throw new Error('no test db');
  const inserted = await active.db.insert(pmMarkets).values({
    chainId: CHAIN_ID,
    contractAddress: CONTRACT_A,
    slug: args.slug,
    clientNonce: args.clientNonce.toLowerCase(),
    creator: args.creator.toLowerCase(),
    shape: args.shape,
    createStatus: 'pending',
    marketId: null,
    title: '',
    description: '',
    streamUrl: '',
    visibilityView: 0,
    visibilityParticipation: 0,
    stakingOpensAt: new Date(0),
    closeAt: new Date(1000),
  }).returning({ id: pmMarkets.id });
  return inserted[0].id;
}

describe('assertPmSponsorDraft — happy path', () => {
  it('returns { ok: true, pendingDbId } when chain + contract + nonce + creator + shape all match', async () => {
    const id = await seedPending({
      slug: 'ABCDEF12',
      clientNonce: NONCE_1,
      creator: SESSION_A,
      shape: 'friendly',
    });

    const r = await assertPmSponsorDraft({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      clientNonce: NONCE_1,
      sessionWallet: SESSION_A,
      shapeFromCall: 'friendly',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pendingDbId).toBe(id);
  });
});

describe('assertPmSponsorDraft — case-insensitive inputs', () => {
  it('uppercased clientNonce + checksummed sessionWallet match a lowercased row', async () => {
    await seedPending({
      slug: 'ABCDEF13',
      clientNonce: NONCE_UPPER,
      creator: SESSION_A,
      shape: 'open_vote',
    });

    const r = await assertPmSponsorDraft({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      clientNonce: NONCE_UPPER, // uppercase
      sessionWallet: SESSION_A,
      shapeFromCall: 'open_vote',
    });

    expect(r.ok).toBe(true);
  });
});

describe('assertPmSponsorDraft — missing draft', () => {
  it('returns pm_draft_missing when no pending row matches the nonce', async () => {
    // No seed.
    const r = await assertPmSponsorDraft({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      clientNonce: NONCE_1,
      sessionWallet: SESSION_A,
      shapeFromCall: 'friendly',
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('pm_draft_missing');
  });

  it('returns pm_draft_missing when the only row is `failed` (not pending)', async () => {
    const id = await seedPending({
      slug: 'ABCDEF14',
      clientNonce: NONCE_1,
      creator: SESSION_A,
      shape: 'friendly',
    });
    // Sweep flipped it to failed.
    await active!.db
      .update(pmMarkets)
      .set({ createStatus: 'failed', failureReason: 'stale-pending-swept' })
      .where(eq(pmMarkets.id, id));

    const r = await assertPmSponsorDraft({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      clientNonce: NONCE_1,
      sessionWallet: SESSION_A,
      shapeFromCall: 'friendly',
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('pm_draft_missing');
  });
});

describe('assertPmSponsorDraft — wrong creator', () => {
  it('returns pm_draft_wrong_creator when row.creator differs from sessionWallet', async () => {
    await seedPending({
      slug: 'ABCDEF15',
      clientNonce: NONCE_1,
      creator: SESSION_A,
      shape: 'friendly',
    });

    const r = await assertPmSponsorDraft({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      clientNonce: NONCE_1,
      sessionWallet: SESSION_B, // different
      shapeFromCall: 'friendly',
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('pm_draft_wrong_creator');
  });
});

// Codex 2C-1 step-9 r1 CRIT-1: regression for postgres-js's
// direct-array result shape. pglite wraps results in `{ rows }`; the
// production postgres-js driver returns the array DIRECTLY. The
// helper must handle both. The pglite tests above prove the wrapped
// shape; this stand-alone block proves the direct-array shape via a
// hand-rolled tx mock that mimics postgres-js.
describe('assertPmSponsorDraft — postgres-js direct-array result shape (Codex r1 CRIT-1)', () => {
  it('handles a result that IS the row array (no .rows wrapper) — happy path', async () => {
    // Build a minimal mock db that exposes `.transaction(cb)` and
    // calls cb with a tx whose `.execute(...)` returns a raw array
    // (mimics postgres-js, NOT pglite). The helper module's `db`
    // import is the Proxy from above; we resolve it to a hand-rolled
    // object for THIS test by swapping `active.db` after import.
    const fakeRowsDirectArray = [
      {
        id: '00000000-0000-0000-0000-00000000beef',
        creator: SESSION_A.toLowerCase(),
        shape: 'friendly',
      },
    ];
    const fakeDb = {
      // The Proxy above forwards `transaction` calls to active.db.
      // We swap active to a stub for this test.
      transaction: async <T,>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
        const fakeTx = {
          execute: async () => fakeRowsDirectArray, // raw array, NO .rows
        };
        return cb(fakeTx);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prev = active;
    active = { db: fakeDb as unknown as TestDb['db'], client: prev!.client, close: prev!.close };

    try {
      const r = await assertPmSponsorDraft({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_A,
        clientNonce: NONCE_1,
        sessionWallet: SESSION_A,
        shapeFromCall: 'friendly',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pendingDbId).toBe('00000000-0000-0000-0000-00000000beef');
    } finally {
      active = prev;
    }
  });

  it('handles a result that IS an empty array (no .rows wrapper) — pm_draft_missing', async () => {
    const fakeDb = {
      transaction: async <T,>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
        const fakeTx = {
          execute: async () => [] as unknown[], // empty raw array
        };
        return cb(fakeTx);
      },
    };
    const prev = active;
    active = { db: fakeDb as unknown as TestDb['db'], client: prev!.client, close: prev!.close };

    try {
      const r = await assertPmSponsorDraft({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_A,
        clientNonce: NONCE_1,
        sessionWallet: SESSION_A,
        shapeFromCall: 'friendly',
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('pm_draft_missing');
    } finally {
      active = prev;
    }
  });
});

describe('assertPmSponsorDraft — shape mismatch', () => {
  it('returns pm_draft_shape_mismatch when row.shape differs from shapeFromCall', async () => {
    await seedPending({
      slug: 'ABCDEF16',
      clientNonce: NONCE_1,
      creator: SESSION_A,
      shape: 'friendly',
    });

    const r = await assertPmSponsorDraft({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      clientNonce: NONCE_1,
      sessionWallet: SESSION_A,
      shapeFromCall: 'open_vote', // different
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('pm_draft_shape_mismatch');
  });
});
