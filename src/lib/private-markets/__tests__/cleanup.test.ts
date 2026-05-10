// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/cleanup.test.ts
//
// Phase 2B-5 sub-phase B: stale-pending sweep tests. pglite-backed so
// the partial unique index (`pm_markets_client_nonce_pending_uniq`)
// behaves exactly like production.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { pmMarkets } from '@/db/schema';

import { sweepStalePending } from '../cleanup';
import { createTestDb, type TestDb } from './test-db';

const CHAIN_ID = 10143;
const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const CONTRACT_OTHER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;
const CREATOR = '0x1111111111111111111111111111111111111111' as const;

let active: TestDb | null = null;

afterEach(async () => {
  if (active) {
    await active.close();
    active = null;
  }
  vi.restoreAllMocks();
});

async function setup(): Promise<TestDb> {
  active = await createTestDb();
  return active;
}

async function seedPendingMarket(opts: {
  marketId?: number;
  clientNonce: `0x${string}`;
  pendingAt: Date;
  contractAddress?: `0x${string}`;
}): Promise<string> {
  const inserted = await active!.db
    .insert(pmMarkets)
    .values({
      chainId: CHAIN_ID,
      contractAddress: opts.contractAddress ?? CONTRACT,
      slug: `dx-${(opts.marketId ?? Math.floor(Math.random() * 1_000_000_000))
        .toString()
        .padStart(8, '0')}`,
      clientNonce: opts.clientNonce,
      creator: CREATOR,
      marketId: opts.marketId ?? null,
      shape: 'friendly',
      createStatus: 'pending',
      pendingAt: opts.pendingAt,
      title: 'Pending market',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    })
    .returning({ id: pmMarkets.id });
  return inserted[0].id;
}

function nonceOf(n: number): `0x${string}` {
  return ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`;
}

describe('sweepStalePending', () => {
  it('sweeps a stale pending row → failed; failed_at + failure_reason set', async () => {
    const t = await setup();
    const now = new Date('2026-05-10T12:00:00Z');
    const pendingAt = new Date('2026-05-10T10:00:00Z'); // 2h ago
    await seedPendingMarket({ clientNonce: nonceOf(1), pendingAt });

    const r = await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000, // 1 hour
      limit: 100,
    });
    expect(r.swept).toBe(1);

    const rows = await t.db.select().from(pmMarkets);
    expect(rows).toHaveLength(1);
    expect(rows[0].createStatus).toBe('failed');
    expect(rows[0].failedAt).toBeInstanceOf(Date);
    expect(rows[0].failureReason).toBe('stale-pending-sweep');
  });

  it('skips fresh pending rows (within TTL)', async () => {
    const t = await setup();
    const now = new Date('2026-05-10T12:00:00Z');
    const freshPendingAt = new Date('2026-05-10T11:30:00Z'); // 30m ago
    await seedPendingMarket({
      clientNonce: nonceOf(2),
      pendingAt: freshPendingAt,
    });

    const r = await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });
    expect(r.swept).toBe(0);
    const rows = await t.db.select().from(pmMarkets);
    expect(rows[0].createStatus).toBe('pending');
  });

  it('skips already-confirmed rows (only pending swept)', async () => {
    const t = await setup();
    const now = new Date('2026-05-10T12:00:00Z');
    await active!.db.insert(pmMarkets).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: 'test-conf',
      clientNonce: nonceOf(3),
      creator: CREATOR,
      marketId: 1,
      shape: 'friendly',
      createStatus: 'confirmed',
      confirmedAt: new Date('2026-05-09T00:00:00Z'),
      pendingAt: new Date('2026-05-09T00:00:00Z'),
      title: 'Confirmed',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
    });
    const r = await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });
    expect(r.swept).toBe(0);
  });

  it('idempotent on already-failed rows', async () => {
    const t = await setup();
    const now = new Date('2026-05-10T12:00:00Z');
    const pendingAt = new Date('2026-05-10T10:00:00Z');
    await seedPendingMarket({ clientNonce: nonceOf(4), pendingAt });

    const r1 = await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });
    expect(r1.swept).toBe(1);
    const r2 = await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });
    expect(r2.swept).toBe(0);
  });

  it('honors limit (50 rows seeded, limit=10, sweeps exactly 10, 40 remain pending)', async () => {
    const t = await setup();
    const now = new Date('2026-05-10T12:00:00Z');
    const pendingAt = new Date('2026-05-10T10:00:00Z');
    for (let i = 0; i < 50; i++) {
      await seedPendingMarket({
        marketId: i,
        clientNonce: nonceOf(100 + i),
        pendingAt,
      });
    }
    const r = await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000,
      limit: 10,
    });
    expect(r.swept).toBe(10);

    const allRows = await t.db.select().from(pmMarkets);
    const swept = allRows.filter((r) => r.createStatus === 'failed');
    const stillPending = allRows.filter(
      (r) => r.createStatus === 'pending',
    );
    expect(swept).toHaveLength(10);
    expect(stillPending).toHaveLength(40);
  });

  it('frees the partial unique index slot: same clientNonce can be re-inserted as pending after sweep', async () => {
    const t = await setup();
    const now = new Date('2026-05-10T12:00:00Z');
    const pendingAt = new Date('2026-05-10T10:00:00Z');
    const nonce = nonceOf(7);
    await seedPendingMarket({ clientNonce: nonce, pendingAt });

    await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });

    // Now insert a NEW pending row with the SAME clientNonce — should
    // succeed because the partial unique index only constrains pending
    // rows, and the previous one was swept to 'failed'.
    await expect(
      seedPendingMarket({ clientNonce: nonce, pendingAt: now }),
    ).resolves.toBeTruthy();
  });

  it('contract-scoped: does NOT sweep rows for a different contract address', async () => {
    const t = await setup();
    const now = new Date('2026-05-10T12:00:00Z');
    const pendingAt = new Date('2026-05-10T10:00:00Z');
    await seedPendingMarket({
      clientNonce: nonceOf(8),
      pendingAt,
      contractAddress: CONTRACT,
    });
    await seedPendingMarket({
      clientNonce: nonceOf(9),
      pendingAt,
      contractAddress: CONTRACT_OTHER,
    });

    const r = await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });
    expect(r.swept).toBe(1);

    const otherContractRow = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.contractAddress, CONTRACT_OTHER));
    expect(otherContractRow[0].createStatus).toBe('pending');
  });

  it('empty input → swept=0, no UPDATE issued', async () => {
    const t = await setup();
    const r = await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now: new Date('2026-05-10T12:00:00Z'),
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });
    expect(r.swept).toBe(0);
  });

  it('emits pm.metric structured-log line on swept > 0', async () => {
    const t = await setup();
    const now = new Date('2026-05-10T12:00:00Z');
    const pendingAt = new Date('2026-05-10T10:00:00Z');
    await seedPendingMarket({ clientNonce: nonceOf(10), pendingAt });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now,
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });

    expect(infoSpy).toHaveBeenCalledOnce();
    const line = infoSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.kind).toBe('pm.metric');
    expect(parsed.code).toBe('stale-pending-swept');
    expect(parsed.swept).toBe(1);
    expect(parsed.component).toBe('pm-maintenance');
  });

  it('quiet on swept = 0 (no info line)', async () => {
    const t = await setup();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await sweepStalePending(t.db as never, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      now: new Date('2026-05-10T12:00:00Z'),
      ttlMs: 60 * 60 * 1000,
      limit: 100,
    });

    expect(infoSpy).not.toHaveBeenCalled();
  });
});
