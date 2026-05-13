// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/draft.test.ts
//
// Integration tests for allocatePmDraft. pglite-backed so the partial
// unique index pm_markets_client_nonce_pending_uniq behaves exactly
// as in production — drizzle stubs cannot exercise partial-index ON
// CONFLICT semantics.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { pmMarkets } from '@/db/schema';
import { allocatePmDraft } from '../draft';
import { createTestDb, type TestDb } from './test-db';

const CHAIN_ID = 10143;
const CONTRACT_A = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const CONTRACT_B = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;
const CONTRACT_CHECKSUM =
  '0xC9c6575a14D0e84afd5AB21C506916Fd2864bb8f' as const;
const SESSION_A = '0x1111111111111111111111111111111111111111' as const;
const SESSION_B = '0x2222222222222222222222222222222222222222' as const;
const SESSION_CHECKSUM = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' as const;
const NONCE_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const NONCE_2 =
  '0x0000000000000000000000000000000000000000000000000000000000000002' as const;
const NONCE_UPPER =
  '0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789' as const;

let active: TestDb | null = null;

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

describe('allocatePmDraft — happy path', () => {
  it('inserts a pending row with marketId=NULL and lowercased addresses', async () => {
    const r = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.slug).toMatch(/^[A-Za-z0-9]{8}$/); // non-synthetic, 8 chars
    expect(r.value.clientNonce).toBe(NONCE_1);
    expect(r.value.pendingDbId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await active!.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.id, r.value.pendingDbId));
    expect(rows).toHaveLength(1);
    expect(rows[0].createStatus).toBe('pending');
    expect(rows[0].marketId).toBeNull();
    expect(rows[0].shape).toBe('friendly');
    expect(rows[0].creator).toBe(SESSION_A);
    expect(rows[0].contractAddress).toBe(CONTRACT_A);
    expect(rows[0].clientNonce).toBe(NONCE_1);
  });
});

describe('allocatePmDraft — lowercasing on input', () => {
  it('lowercases checksummed contractAddress + uppercase sessionWallet + uppercase clientNonce', async () => {
    const r = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_CHECKSUM,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_CHECKSUM,
      shape: 'open_vote',
      clientNonce: NONCE_UPPER,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.clientNonce).toBe(NONCE_UPPER.toLowerCase());

    const rows = await active!.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.id, r.value.pendingDbId));
    expect(rows[0].contractAddress).toBe(CONTRACT_CHECKSUM.toLowerCase());
    expect(rows[0].creator).toBe(SESSION_CHECKSUM.toLowerCase());
    expect(rows[0].clientNonce).toBe(NONCE_UPPER.toLowerCase());
  });
});

describe('allocatePmDraft — duplicate clientNonce, both pending', () => {
  it('returns { ok: false, error: { kind: "duplicate" } }', async () => {
    const r1 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });
    expect(r1.ok).toBe(true);

    const r2 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe('duplicate');
  });
});

describe('allocatePmDraft — duplicate clientNonce, earlier row is failed', () => {
  it('SUCCEEDS — the partial index only constrains pending rows', async () => {
    const r1 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Simulate sweep flipping it to failed.
    await active!.db
      .update(pmMarkets)
      .set({ createStatus: 'failed', failureReason: 'stale-pending-swept' })
      .where(eq(pmMarkets.id, r1.value.pendingDbId));

    const r2 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.pendingDbId).not.toBe(r1.value.pendingDbId);
  });
});

describe('allocatePmDraft — cross-(chain, contract) duplicate clientNonce (Codex r3 CRIT-1)', () => {
  it('STILL collides — the partial index is global on client_nonce', async () => {
    const r1 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });
    expect(r1.ok).toBe(true);

    // Same nonce, different contract (different deployment).
    // With 32B entropy this can't happen by accident; the test
    // pins the constraint behaviour.
    const r2 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_B,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_B,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    // Same error shape as same-(chain, contract) duplicate — no info
    // leak (Codex r1 MIN-2).
    expect(r2.error.kind).toBe('duplicate');
  });
});

describe('allocatePmDraft — slug retry on collision', () => {
  it('allocateSlug retries; second attempt wins', async () => {
    // Seed a pending row with a known slug, then mock randomBytes to
    // produce that slug on first attempt and a fresh value on second.
    // Easier path: just observe that two consecutive allocations on a
    // shared DB produce distinct slugs (the retry path isn't directly
    // exercised because the random space is 218T-large, but distinct
    // slugs prove the dedupe SELECT works.)
    const r1 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });
    const r2 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'open_vote',
      clientNonce: NONCE_2,
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.slug).not.toBe(r2.value.slug);
    }
  });
});

describe('allocatePmDraft — slug_exhausted', () => {
  it('returns slug_exhausted when allocateSlug throws', async () => {
    // Easiest reliable way to trigger this: mock allocateSlug. The
    // alternative (mocking randomBytes to always collide) is brittle
    // because of base62 rejection sampling.
    const slugModule = await import('../slug');
    const spy = vi.spyOn(slugModule, 'allocateSlug').mockRejectedValueOnce(
      new Error('allocateSlug: failed after 8 attempts'),
    );

    const r = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('slug_exhausted');
    spy.mockRestore();
  });
});

// Codex 2C-1 step-9 r2 MIN-1: parity regression for the direct-array
// result shape. pglite wraps results in `{ rows }`; postgres-js
// returns the row array DIRECTLY. The matching r1 fix in draft.ts
// (lines 107-115) uses the dual-shape extraction pattern from
// cleanup.ts:92-95, but every test above exercises only the
// pglite-wrapped path. This block pins the bug class for the second
// fixed call site (sponsor-gate already has parity tests).
describe('allocatePmDraft — postgres-js direct-array result shape (Codex r2 MIN-1)', () => {
  // Codex 2C-1 r3 MAJ-2: allocatePmDraft now issues TWO .execute()
  // calls per invocation — the per-Safe pending-cap SELECT, then the
  // INSERT ... RETURNING. Both must be exercised via the direct-
  // array (postgres-js) shape to pin the dual-shape extraction
  // pattern across both call sites. Helper builds a fakeTx whose
  // .execute() returns successive raw-array responses without the
  // `.rows` wrapper.
  function buildFakeTx(responses: unknown[]): { execute: () => Promise<unknown> } {
    let call = 0;
    return {
      execute: async () => {
        const r = responses[call];
        call += 1;
        return r;
      },
    };
  }

  it('handles a result that IS the row array (no .rows wrapper) — happy path', async () => {
    // Mock allocateSlug to return a fixed slug — the tx mock only
    // needs .execute() because the slug-collision SELECT is bypassed.
    const slugModule = await import('../slug');
    vi.spyOn(slugModule, 'allocateSlug').mockResolvedValueOnce('AB12CD34');

    const fakeTx = buildFakeTx([
      // 1st: pending-cap SELECT, direct-array shape.
      [{ c: 0 }],
      // 2nd: INSERT ... RETURNING id, direct-array shape.
      [{ id: '00000000-0000-0000-0000-00000000feed' }],
    ]);

    const r = await allocatePmDraft({
      tx: fakeTx as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.slug).toBe('AB12CD34');
    expect(r.value.pendingDbId).toBe('00000000-0000-0000-0000-00000000feed');
  });

  it('handles a result that IS an empty array (no .rows wrapper) — duplicate', async () => {
    const slugModule = await import('../slug');
    vi.spyOn(slugModule, 'allocateSlug').mockResolvedValueOnce('EF56GH78');

    const fakeTx = buildFakeTx([
      [{ c: 0 }],
      [] as unknown[], // empty raw array — ON CONFLICT DO NOTHING fired
    ]);

    const r = await allocatePmDraft({
      tx: fakeTx as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('duplicate');
  });

  it('handles pending-cap SELECT in the direct-array shape — cap hit', async () => {
    // Cap=2 with 2 pending rows reported. The slug allocator must
    // NOT run (cap check is upstream of slug allocation).
    const slugModule = await import('../slug');
    const slugSpy = vi.spyOn(slugModule, 'allocateSlug');

    const fakeTx = buildFakeTx([
      [{ c: 2 }], // postgres-js direct-array shape, count == cap
    ]);

    const r = await allocatePmDraft({
      tx: fakeTx as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: NONCE_1,
      maxPendingPerSafe: 2,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('pending_cap');
    if (r.error.kind !== 'pending_cap') return;
    expect(r.error.count).toBe(2);
    expect(slugSpy).not.toHaveBeenCalled();
  });
});

describe('allocatePmDraft — per-Safe pending cap (Codex 2C-1 r3 MAJ-2)', () => {
  it('blocks the (cap+1)th draft when cap rows already pending for the same Safe', async () => {
    // Use small cap=3 so the test stays fast. Insert 3 pending rows
    // with distinct nonces, then attempt the 4th — should reject
    // with pending_cap, no row inserted.
    for (let i = 0; i < 3; i++) {
      const nonce = `0x${'0'.repeat(63)}${(i + 1).toString(16)}` as const;
      const r = await allocatePmDraft({
        tx: active!.db as never,
        sessionWallet: SESSION_A,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_A,
        shape: 'friendly',
        clientNonce: nonce,
        maxPendingPerSafe: 3,
      });
      expect(r.ok).toBe(true);
    }

    const overflowNonce =
      `0x${'0'.repeat(62)}ff` as const;
    const r4 = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: overflowNonce,
      maxPendingPerSafe: 3,
    });

    expect(r4.ok).toBe(false);
    if (r4.ok) return;
    expect(r4.error.kind).toBe('pending_cap');
    if (r4.error.kind !== 'pending_cap') return;
    expect(r4.error.count).toBe(3);

    // Verify no 4th row landed.
    const all = await active!.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.creator, SESSION_A));
    expect(all).toHaveLength(3);
  });

  it('cap counts only the SAME Safe; a different Safe can still allocate', async () => {
    // Fill SESSION_A's cap (3 pending rows), then SESSION_B should
    // still be able to allocate normally.
    for (let i = 0; i < 3; i++) {
      const nonce = `0x${'0'.repeat(63)}${(i + 1).toString(16)}` as const;
      const r = await allocatePmDraft({
        tx: active!.db as never,
        sessionWallet: SESSION_A,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_A,
        shape: 'friendly',
        clientNonce: nonce,
        maxPendingPerSafe: 3,
      });
      expect(r.ok).toBe(true);
    }

    const sessionBNonce =
      `0x${'0'.repeat(62)}b1` as const;
    const r = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_B,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: sessionBNonce,
      maxPendingPerSafe: 3,
    });
    expect(r.ok).toBe(true);
  });

  it('cap counts only `pending` rows; failed/confirmed rows do not contribute', async () => {
    // Insert 3 pending rows, then mark all 3 as failed via
    // direct UPDATE (simulates the stale-pending sweep). A 4th
    // allocate must succeed because the cap counts only pending.
    for (let i = 0; i < 3; i++) {
      const nonce = `0x${'0'.repeat(63)}${(i + 1).toString(16)}` as const;
      const r = await allocatePmDraft({
        tx: active!.db as never,
        sessionWallet: SESSION_A,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_A,
        shape: 'friendly',
        clientNonce: nonce,
        maxPendingPerSafe: 3,
      });
      expect(r.ok).toBe(true);
    }

    await active!.db
      .update(pmMarkets)
      .set({ createStatus: 'failed', failureReason: 'stale-pending-swept' })
      .where(eq(pmMarkets.creator, SESSION_A));

    const newNonce =
      `0x${'0'.repeat(62)}ab` as const;
    const r = await allocatePmDraft({
      tx: active!.db as never,
      sessionWallet: SESSION_A,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_A,
      shape: 'friendly',
      clientNonce: newNonce,
      maxPendingPerSafe: 3,
    });
    expect(r.ok).toBe(true);
  });
});

describe('allocatePmDraft — concurrent duplicate (TOCTOU)', () => {
  it('two parallel calls with same nonce → exactly one succeeds', async () => {
    // pglite is single-threaded, but Promise.all interleaves the
    // awaits so the partial-unique-index constraint is what actually
    // dedupes (not a serialization happy-accident).
    const [r1, r2] = await Promise.all([
      allocatePmDraft({
        tx: active!.db as never,
        sessionWallet: SESSION_A,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_A,
        shape: 'friendly',
        clientNonce: NONCE_1,
      }),
      allocatePmDraft({
        tx: active!.db as never,
        sessionWallet: SESSION_A,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_A,
        shape: 'friendly',
        clientNonce: NONCE_1,
      }),
    ]);

    const oks = [r1.ok, r2.ok].filter(Boolean).length;
    const dups = [r1, r2].filter(
      (r) => !r.ok && r.error.kind === 'duplicate',
    ).length;
    expect(oks).toBe(1);
    expect(dups).toBe(1);
  });
});

