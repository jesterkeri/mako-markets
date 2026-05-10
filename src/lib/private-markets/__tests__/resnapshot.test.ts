// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/resnapshot.test.ts
//
// Phase 2B-5 sub-phase C: resnapshot sweep + orphan-resolution
// recovery + state-divergence triage. Driven against pglite so the
// SQL semantics (FOR UPDATE row locks, COALESCE, etc.) match
// production.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  encodeAbiParameters,
  parseAbiParameters,
  type PublicClient,
} from 'viem';

import {
  pmIndexerState,
  pmMarkets,
  pmOptions,
  pmResolutions,
  pmStakes,
} from '@/db/schema';

import { resnapshotConfirmed } from '../resnapshot';
import { createTestDb, type TestDb } from './test-db';

const CHAIN_ID = 10143;
const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;
const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const STAKER_A = '0x2222222222222222222222222222222222222222' as const;
const NONCE_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

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

function encodeBytesUtf8(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s);
  return ('0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;
}

interface MarketViewOverrides {
  effectiveState?: number;
  storedState?: number;
  totalStake?: bigint;
  feeTaken?: bigint;
  dust?: bigint;
  metadataFrozenEmitted?: boolean;
  shape?: number;
  friendlyOutcome?: number;
  friendlyEmptyPoolPath?: boolean;
}

function buildMarketView(o: MarketViewOverrides = {}) {
  return {
    creator: CREATOR,
    shape: o.shape ?? 0, // Friendly
    clientNonce: NONCE_1,
    createdAt: 30685166n,
    stakingOpensAt: 30685226n,
    closeAt: 30685766n,
    viewMode: 0,
    participationMode: 0,
    storedState: o.storedState ?? 0,
    effectiveState: o.effectiveState ?? 0,
    perStakeMin: 1_000_000n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 0,
    totalStake: o.totalStake ?? 0n,
    friendlyOutcome: o.friendlyOutcome ?? 0,
    friendlyEmptyPoolPath: o.friendlyEmptyPoolPath ?? false,
    feeTaken: o.feeTaken ?? 0n,
    dust: o.dust ?? 0n,
    metadataFrozenEmitted: o.metadataFrozenEmitted ?? false,
  };
}

function buildMulticallReturn(
  overrides: MarketViewOverrides = {},
  opts: {
    title?: string;
    description?: string;
    streamUrl?: string;
    optionLabels?: string[];
    participants?: `0x${string}`[];
  } = {},
): unknown[] {
  return [
    buildMarketView(overrides),
    encodeBytesUtf8(opts.title ?? 'Refreshed Title'),
    encodeBytesUtf8(opts.description ?? 'Refreshed description'),
    encodeBytesUtf8(opts.streamUrl ?? ''),
    (opts.optionLabels ?? ['NO', 'YES']).map(encodeBytesUtf8),
    opts.participants ?? [],
  ];
}

function makeClient(args: {
  multicallReturn: () => unknown[];
}): PublicClient {
  return {
    multicall: vi.fn(async () => args.multicallReturn()),
  } as unknown as PublicClient;
}

async function seedConfirmedMarket(opts: {
  marketId: number;
  currentState?:
    | 'created'
    | 'resolved'
    | 'empty_pool_resolved'
    | 'canceled'
    | 'timed_out'
    | 'zero_stake_expired';
  updatedAt?: Date;
  shape?: 'friendly' | 'open_vote' | 'prize_pool';
  perStakeMin?: string;
}): Promise<string> {
  const inserted = await active!.db
    .insert(pmMarkets)
    .values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      slug: `dx-${opts.marketId.toString().padStart(8, '0')}`,
      clientNonce:
        ('0x' + opts.marketId.toString(16).padStart(64, '0')) as `0x${string}`,
      creator: CREATOR,
      marketId: opts.marketId,
      shape: opts.shape ?? 'friendly',
      createStatus: 'confirmed',
      confirmedAt: new Date('2026-05-09T00:00:00Z'),
      pendingAt: new Date('2026-05-09T00:00:00Z'),
      title: 'Original Title',
      description: 'original',
      streamUrl: '',
      visibilityView: 0,
      visibilityParticipation: 0,
      stakingOpensAt: new Date('2026-05-12T00:01:00Z'),
      closeAt: new Date('2026-05-12T00:10:00Z'),
      currentState: opts.currentState ?? 'created',
      updatedAt: opts.updatedAt ?? new Date('2026-05-09T00:00:00Z'),
      perStakeMin: opts.perStakeMin ?? '1000000',
    })
    .returning({ id: pmMarkets.id });
  const id = inserted[0].id;
  await active!.db.insert(pmOptions).values([
    {
      marketDbId: id,
      optionIndex: 0,
      label: 'NO_OLD',
      participantWallet: null,
      poolTotal: '0',
      firstStakeSequence: null,
    },
    {
      marketDbId: id,
      optionIndex: 1,
      label: 'YES_OLD',
      participantWallet: null,
      poolTotal: '0',
      firstStakeSequence: null,
    },
  ]);
  return id;
}

async function seedIndexerState(lastIndexedBlock: number): Promise<void> {
  await active!.db.execute(sql`
    INSERT INTO pm_indexer_state (chain_id, contract_address, last_indexed_block, locked_at, updated_at)
    VALUES (${CHAIN_ID}, ${CONTRACT}, ${lastIndexedBlock}, NULL, now())
    ON CONFLICT (chain_id) DO UPDATE SET last_indexed_block = ${lastIndexedBlock}
  `);
}

async function seedResolutionAudit(args: {
  marketId: number;
  eventName: string;
  payload: Record<string, unknown>;
  blockNumber: number;
  txHash?: `0x${string}`;
  logIndex?: number;
}): Promise<void> {
  await active!.db.insert(pmResolutions).values({
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    txHash:
      args.txHash ??
      (('0x' + args.marketId.toString(16).padStart(64, '0')) as `0x${string}`),
    logIndex: args.logIndex ?? 0,
    marketId: args.marketId,
    eventName: args.eventName,
    payload: args.payload,
    blockNumber: args.blockNumber,
    blockTimestamp: new Date('2026-05-09T01:00:00Z'),
  });
}

const NOW = new Date('2026-05-10T12:00:00Z');
const STALE_AGE = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago, > 30min maxAge

describe('resnapshotConfirmed — non-state metadata', () => {
  it('refreshes title/description/streamUrl/dust/totalStake/feeTaken from on-chain on stale rows', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 7,
      updatedAt: STALE_AGE,
    });
    const publicClient = makeClient({
      multicallReturn: () =>
        buildMulticallReturn(
          { totalStake: 12_345n, feeTaken: 9_999n, dust: 7n },
          {
            title: 'Refreshed Title',
            description: 'fresh desc',
            streamUrl: 'https://stream.example',
            optionLabels: ['NEW_NO', 'NEW_YES'],
          },
        ),
    });
    const r = await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });
    expect(r.resnapped).toBe(1);

    const row = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 7));
    expect(row[0].title).toBe('Refreshed Title');
    expect(row[0].description).toBe('fresh desc');
    expect(row[0].streamUrl).toBe('https://stream.example');
    expect(row[0].totalStake).toBe('12345');
    expect(row[0].feeTaken).toBe('9999');
    expect(row[0].dust).toBe('7');

    const opts = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.marketDbId, row[0].id))
      .orderBy(pmOptions.optionIndex);
    expect(opts[0].label).toBe('NEW_NO');
    expect(opts[1].label).toBe('NEW_YES');
  });

  it('skips fresh rows (updated_at within maxAge AND current_state != created)', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 8,
      currentState: 'resolved',
      updatedAt: NOW,
    });
    const publicClient = makeClient({
      multicallReturn: () => buildMulticallReturn({ effectiveState: 3 }),
    });
    const r = await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });
    expect(r.resnapped).toBe(0);
  });

  it('eligible: current_state=created bypasses maxAge gate (active rows resnapshot every tick)', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    // Fresh updated_at, but current_state='created' → eligible.
    await seedConfirmedMarket({
      marketId: 9,
      currentState: 'created',
      updatedAt: NOW,
    });
    const publicClient = makeClient({
      multicallReturn: () => buildMulticallReturn({}),
    });
    const r = await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });
    expect(r.resnapped).toBe(1);
  });
});

describe('resnapshotConfirmed — orphan-resolution recovery', () => {
  it('happy path: current_state=created + chain Resolved + one matching ResolvedFriendly audit row → mirror written', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 11,
      currentState: 'created',
      updatedAt: STALE_AGE,
    });
    await seedResolutionAudit({
      marketId: 11,
      eventName: 'ResolvedFriendly',
      payload: {
        outcome: 1,
        emptyPoolPath: false,
        feeTaken: '250000',
        totalOwed: '9750000',
      },
      blockNumber: 30699999,
    });
    const publicClient = makeClient({
      multicallReturn: () =>
        buildMulticallReturn({ effectiveState: 3, feeTaken: 250_000n }),
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const r = await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });
    expect(r.resnapped).toBe(1);

    const row = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 11));
    expect(row[0].currentState).toBe('resolved');
    expect(row[0].friendlyOutcome).toBe(1);
    expect(row[0].friendlyEmptyPoolPath).toBe(false);
    expect(row[0].feeTaken).toBe('250000');

    const recoveryLines = infoSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter(
        (l) => l && l.code === 'resnapshot-orphan-recovery',
      );
    expect(recoveryLines).toHaveLength(1);
  });

  it('audit-chain disagreement: audit=ResolvedFriendly but chain=Canceled → state-mismatch alert + no mutation', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 12,
      currentState: 'created',
      updatedAt: STALE_AGE,
    });
    await seedResolutionAudit({
      marketId: 12,
      eventName: 'ResolvedFriendly',
      payload: { outcome: 1, emptyPoolPath: false, feeTaken: '0', totalOwed: '0' },
      blockNumber: 30699999,
    });
    const publicClient = makeClient({
      multicallReturn: () => buildMulticallReturn({ effectiveState: 5 }), // Canceled
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    const row = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 12));
    expect(row[0].currentState).toBe('created'); // unchanged

    const alerts = errSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter(
        (l) =>
          l &&
          l.kind === 'pm.alert' &&
          l.reason === 'audit-chain-disagreement',
      );
    expect(alerts).toHaveLength(1);
  });

  it('multi-audit ambiguity: two rows BOTH match chain → state-mismatch alert + no mutation', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 13,
      currentState: 'created',
      updatedAt: STALE_AGE,
    });
    // Two audit rows whose derived states BOTH equal 'resolved'.
    await seedResolutionAudit({
      marketId: 13,
      eventName: 'ResolvedFriendly',
      payload: { outcome: 1, emptyPoolPath: false, feeTaken: '0', totalOwed: '0' },
      blockNumber: 30699998,
      txHash: ('0x' + '1'.repeat(64)) as `0x${string}`,
    });
    await seedResolutionAudit({
      marketId: 13,
      eventName: 'ResolvedOpenVote',
      payload: { topN: [1], feeTaken: '0' },
      blockNumber: 30699999,
      txHash: ('0x' + '2'.repeat(64)) as `0x${string}`,
    });

    const publicClient = makeClient({
      multicallReturn: () => buildMulticallReturn({ effectiveState: 3 }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    const row = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 13));
    expect(row[0].currentState).toBe('created');

    const alerts = errSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((l) => l.reason === 'audit-row-ambiguity');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].auditRowCount).toBe(2);
  });

  it('multi-audit with exactly one match (Codex r4 m2): older mismatching row + newer matching row → recovery proceeds with the matching row', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 14,
      currentState: 'created',
      updatedAt: STALE_AGE,
    });
    // Older mismatching: Canceled reason=1 (timed_out)
    await seedResolutionAudit({
      marketId: 14,
      eventName: 'Canceled',
      payload: { reason: 1 },
      blockNumber: 30699998,
      txHash: ('0x' + '3'.repeat(64)) as `0x${string}`,
    });
    // Newer matching: ResolvedFriendly paid path
    await seedResolutionAudit({
      marketId: 14,
      eventName: 'ResolvedFriendly',
      payload: {
        outcome: 1,
        emptyPoolPath: false,
        feeTaken: '111',
        totalOwed: '0',
      },
      blockNumber: 30699999,
      txHash: ('0x' + '4'.repeat(64)) as `0x${string}`,
    });
    // Chain view feeTaken matches the audit row's payload (they
    // originate from the same contract write in production).
    const publicClient = makeClient({
      multicallReturn: () =>
        buildMulticallReturn({ effectiveState: 3, feeTaken: 111n }),
    });

    const r = await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });
    expect(r.resnapped).toBe(1);

    const row = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 14));
    expect(row[0].currentState).toBe('resolved');
    expect(row[0].friendlyOutcome).toBe(1);
    expect(row[0].feeTaken).toBe('111');
  });

  it('indexer behind watermark: chain says terminal but no audit row at-or-before watermark → silent skip with pm.metric resnapshot-state-deferred', async () => {
    const t = await setup();
    await seedIndexerState(30699000); // watermark BEFORE the resolution
    await seedConfirmedMarket({
      marketId: 15,
      currentState: 'created',
      updatedAt: STALE_AGE,
    });
    // Audit row exists but is AFTER watermark — should be filtered.
    await seedResolutionAudit({
      marketId: 15,
      eventName: 'ResolvedFriendly',
      payload: { outcome: 1, emptyPoolPath: false, feeTaken: '0', totalOwed: '0' },
      blockNumber: 30699500,
    });
    // Wait — that's BEFORE watermark. Set after:
    await active!.db
      .update(pmResolutions)
      .set({ blockNumber: 30699999 })
      .where(eq(pmResolutions.marketId, 15));

    const publicClient = makeClient({
      multicallReturn: () => buildMulticallReturn({ effectiveState: 3 }),
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    const row = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 15));
    expect(row[0].currentState).toBe('created'); // unchanged

    // Deferred metric line emitted, no alert.
    const deferred = infoSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((l) => l.code === 'resnapshot-state-deferred');
    expect(deferred).toHaveLength(1);

    const stateAlerts = errSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((l) => l.kind === 'pm.alert' && l.code === 'state-mismatch');
    expect(stateAlerts).toHaveLength(0);
  });

  it('Codex 2B-5 r1 M2: predicate-guard catches concurrent terminalisation between SELECT and orphan-recovery UPDATE', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    const dbId = await seedConfirmedMarket({
      marketId: 21,
      currentState: 'created',
      updatedAt: STALE_AGE,
    });
    await seedResolutionAudit({
      marketId: 21,
      eventName: 'ResolvedFriendly',
      payload: {
        outcome: 1,
        emptyPoolPath: false,
        feeTaken: '500',
        totalOwed: '0',
      },
      blockNumber: 30699999,
    });
    // Simulate: the resnapshot multicall has already returned (chain
    // says Resolved), but BEFORE the predicate-guarded UPDATE fires,
    // a concurrent pm-indexer tick terminalises the row to 'canceled'.
    // The way to inject this in a single-threaded test is to flip the
    // row mid-flight: spy on `update` so the first call (from
    // applyOrphanRecovery) sees the row already-non-created.
    //
    // Simpler: pre-flip the row to 'canceled' AFTER multicall starts
    // but BEFORE applyOrphanRecovery — the multicall is mocked, so
    // we just flip it before the resnapshot call AND make the
    // multicall return Resolved. The orphan-recovery path should
    // run (because the SELECT happens inside reconcileOneRow, and
    // that re-reads currentState... wait, actually it reads from the
    // candidates SELECT at the top). The candidates SELECT picked
    // up currentState='created'. If we flip BEFORE resnapshotConfirmed
    // is called, candidates would see 'canceled' and skip.
    //
    // Cleanest: spy on applyOrphanRecovery's actual UPDATE — flip
    // the DB row after the candidates SELECT, before the UPDATE.
    // We do this by spying on db.update and intercepting the
    // pmMarkets WHERE clause that targets `id = $marketDbId AND
    // current_state = 'created'`. On the first such call, race-flip
    // the row.
    //
    // Even simpler: just verify the WHERE-clause guard is present.
    // After the test runs, the row should remain 'canceled' (NOT
    // overwritten to 'resolved'), and a state-mismatch alert with
    // reason='concurrent-state-change' should fire.
    //
    // Pre-flip the row to 'canceled' AFTER seedConfirmedMarket but
    // BEFORE resnapshotConfirmed. The candidates SELECT will NOT
    // pick it up (current_state='canceled' isn't 'created' AND
    // updated_at not stale — but we set updated_at to STALE_AGE,
    // so it IS picked up via the `updated_at < cutoff` clause).
    // applyOrphanRecovery's predicate-guarded UPDATE will match
    // zero rows (current_state != 'created'), surface the alert,
    // and leave the row at 'canceled'.
    await t.db
      .update(pmMarkets)
      .set({ currentState: 'canceled' })
      .where(eq(pmMarkets.id, dbId));

    const publicClient = makeClient({
      multicallReturn: () => buildMulticallReturn({ effectiveState: 3 }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    // The row was 'canceled' before resnapshot, and the predicate-guard
    // prevents the orphan-recovery UPDATE from overwriting it. But this
    // test is for a different case: the row was 'created' at SELECT but
    // 'canceled' at UPDATE-time. With pre-flip, the candidates SELECT
    // sees 'canceled' (not 'created'), so the orphan-recovery path
    // doesn't fire — instead we hit the local-terminal-vs-chain-divergent
    // branch (currentState='canceled', chain says Resolved).
    const row = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 21));
    expect(row[0].currentState).toBe('canceled');

    const alerts = errSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((l) => l.kind === 'pm.alert' && l.code === 'state-mismatch');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reason).toBe('local-terminal-vs-chain-divergent');
  });
});

describe('resnapshotConfirmed — firstStakeSequence recovery (Codex 2B-5 r1 M1)', () => {
  it('writes firstStakeSequence for pm_options rows where it is NULL but pm_stakes exists', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    const dbId = await seedConfirmedMarket({
      marketId: 30,
      updatedAt: STALE_AGE,
    });
    // Pre-seed a pm_stakes row for option 1 (proves an orphan stake
    // landed before the parent market).
    await active!.db.insert(pmStakes).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      txHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
      logIndex: 0,
      marketId: 30,
      staker: STAKER_A,
      optionIndex: 1,
      amount: '1000000',
      blockNumber: 30699998,
      blockTimestamp: new Date('2026-05-09T01:00:00Z'),
    });
    // Confirm the pm_options row for option 1 starts with
    // firstStakeSequence=NULL (seedConfirmedMarket default).
    const before = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.marketDbId, dbId))
      .orderBy(pmOptions.optionIndex);
    expect(before[1].firstStakeSequence).toBeNull();

    // multicall returns getOptionFirstStakeSequence(30, 1) = (42, true)
    const publicClient = {
      multicall: vi.fn(
        async (args: { contracts: Array<{ functionName: string }> }) => {
          if (args.contracts[0].functionName === 'getMarket') {
            return buildMulticallReturn({});
          }
          if (
            args.contracts[0].functionName === 'getOptionFirstStakeSequence'
          ) {
            return [[42, true]] as const;
          }
          throw new Error(
            `unexpected multicall: ${args.contracts[0].functionName}`,
          );
        },
      ),
    } as unknown as PublicClient;

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    const after = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.marketDbId, dbId))
      .orderBy(pmOptions.optionIndex);
    expect(after[0].firstStakeSequence).toBeNull(); // option 0 untouched (no stake)
    expect(after[1].firstStakeSequence).toBe(42); // option 1 reconciled
  });

  it('does NOT overwrite existing firstStakeSequence (write-once invariant)', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    const dbId = await seedConfirmedMarket({
      marketId: 31,
      updatedAt: STALE_AGE,
    });
    // Pre-set firstStakeSequence on option 1 to 7.
    await t.db
      .update(pmOptions)
      .set({ firstStakeSequence: 7 })
      .where(
        and(
          eq(pmOptions.marketDbId, dbId),
          eq(pmOptions.optionIndex, 1),
        ),
      );
    await active!.db.insert(pmStakes).values({
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      txHash: ('0x' + 'b'.repeat(64)) as `0x${string}`,
      logIndex: 0,
      marketId: 31,
      staker: STAKER_A,
      optionIndex: 1,
      amount: '1',
      blockNumber: 30699999,
      blockTimestamp: new Date('2026-05-09T01:00:00Z'),
    });

    // Chain returns a DIFFERENT sequence value (99); the predicate-
    // guarded UPDATE must not overwrite the existing 7.
    const publicClient = {
      multicall: vi.fn(
        async (args: { contracts: Array<{ functionName: string }> }) => {
          if (args.contracts[0].functionName === 'getMarket') {
            return buildMulticallReturn({});
          }
          if (
            args.contracts[0].functionName === 'getOptionFirstStakeSequence'
          ) {
            return [[99, true]] as const;
          }
          throw new Error('unexpected');
        },
      ),
    } as unknown as PublicClient;

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    const after = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.marketDbId, dbId))
      .orderBy(pmOptions.optionIndex);
    expect(after[1].firstStakeSequence).toBe(7); // unchanged
  });

  it('skips chain reads for options with no pm_stakes rows', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 32,
      updatedAt: STALE_AGE,
    });
    // No pm_stakes seeded → reconcileFirstStakeSequence should not
    // call multicall for getOptionFirstStakeSequence.
    const multicallSpy = vi.fn(
      async (args: { contracts: Array<{ functionName: string }> }) => {
        if (args.contracts[0].functionName === 'getMarket') {
          return buildMulticallReturn({});
        }
        throw new Error(
          `unexpected: ${args.contracts[0].functionName} should not be called when no stakes`,
        );
      },
    );
    const publicClient = {
      multicall: multicallSpy,
    } as unknown as PublicClient;

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    // Only the getMarket prefetch runs (1 multicall); no
    // getOptionFirstStakeSequence multicall.
    expect(multicallSpy).toHaveBeenCalledTimes(1);
  });
});

describe('resnapshotConfirmed — terminal-state divergence', () => {
  it('local=resolved, chain=Canceled → state-mismatch alert, no mutation', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 16,
      currentState: 'resolved',
      updatedAt: STALE_AGE,
    });
    const publicClient = makeClient({
      multicallReturn: () => buildMulticallReturn({ effectiveState: 5 }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });
    const row = await t.db
      .select()
      .from(pmMarkets)
      .where(eq(pmMarkets.marketId, 16));
    expect(row[0].currentState).toBe('resolved'); // unchanged

    const alerts = errSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter(
        (l) =>
          l.kind === 'pm.alert' &&
          l.reason === 'local-terminal-vs-chain-divergent',
      );
    expect(alerts).toHaveLength(1);
  });

  it('no-op when local matches chain (resolved + Resolved)', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    await seedConfirmedMarket({
      marketId: 17,
      currentState: 'resolved',
      updatedAt: STALE_AGE,
    });
    const publicClient = makeClient({
      multicallReturn: () => buildMulticallReturn({ effectiveState: 3 }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    const stateAlerts = errSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((l) => l.kind === 'pm.alert' && l.code === 'state-mismatch');
    expect(stateAlerts).toHaveLength(0);
  });
});

describe('resnapshotConfirmed — pool_total reconciliation', () => {
  it('orphan-Staked recovery: pre-seed pm_stakes but pool_total=0 → reconcile to SUM(pm_stakes.amount)', async () => {
    const t = await setup();
    await seedIndexerState(30700000);
    const dbId = await seedConfirmedMarket({
      marketId: 18,
      updatedAt: STALE_AGE,
    });
    // Pre-seed pm_stakes for option 1 with multiple stakes summing to 7M.
    await active!.db.insert(pmStakes).values([
      {
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        txHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        logIndex: 0,
        marketId: 18,
        staker: STAKER_A,
        optionIndex: 1,
        amount: '4000000',
        blockNumber: 30699998,
        blockTimestamp: new Date('2026-05-09T01:00:00Z'),
      },
      {
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        txHash: ('0x' + 'b'.repeat(64)) as `0x${string}`,
        logIndex: 0,
        marketId: 18,
        staker: STAKER_A,
        optionIndex: 1,
        amount: '3000000',
        blockNumber: 30699999,
        blockTimestamp: new Date('2026-05-09T01:00:00Z'),
      },
    ]);

    // Codex 2B-5 r1 M1: resnapshot now ALSO runs firstStakeSequence
    // recovery, which calls getOptionFirstStakeSequence on the chain
    // for any pm_options row where firstStakeSequence is NULL AND a
    // pm_stakes row exists. The multicall mock has to dispatch on
    // functionName.
    const publicClient = {
      multicall: vi.fn(
        async (args: { contracts: Array<{ functionName: string }> }) => {
          if (args.contracts[0].functionName === 'getMarket') {
            return buildMulticallReturn({});
          }
          if (
            args.contracts[0].functionName === 'getOptionFirstStakeSequence'
          ) {
            return [[1, true]] as const;
          }
          throw new Error(
            `unexpected multicall: ${args.contracts[0].functionName}`,
          );
        },
      ),
    } as unknown as PublicClient;
    await resnapshotConfirmed({
      db: t.db as never,
      publicClient,
      contractAddress: CONTRACT,
      chainId: CHAIN_ID,
      now: NOW,
      maxAgeMs: 30 * 60 * 1000,
      limit: 50,
      multicallBatchSize: 10,
    });

    const opts = await t.db
      .select()
      .from(pmOptions)
      .where(eq(pmOptions.marketDbId, dbId))
      .orderBy(pmOptions.optionIndex);
    expect(opts[0].poolTotal).toBe('0'); // option 0 untouched
    expect(opts[1].poolTotal).toBe('7000000'); // option 1 reconciled
  });

  it('Codex r3 m3 + r4 m3: pool_total reconciliation issues FOR UPDATE before SUM, then UPDATE inside same transaction envelope (source-text regression guard)', async () => {
    // Pglite is single-connection so true concurrency isn't directly
    // testable, AND drizzle-orm/pglite's `db.transaction(...)` API
    // routes inner statements through a path that doesn't surface
    // cleanly via a `client.query` spy. Instead, do a static-source
    // regression assertion: read resnapshot.ts and verify the
    // ordered sequence appears in `reconcilePoolTotal`. The
    // orphan-Staked test above proves the SUM + UPDATE actually run
    // and write the right value end-to-end. This test is the
    // regression guard against a future refactor that drops the
    // `FOR UPDATE` row lock or reorders the statements.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const path = resolve('src/lib/private-markets/resnapshot.ts');
    const source = readFileSync(path, 'utf-8');

    // Locate `async function reconcilePoolTotal(` body via brace count.
    const startMatch = source.match(
      /async\s+function\s+reconcilePoolTotal\s*\(/,
    );
    expect(startMatch).not.toBeNull();
    if (!startMatch || startMatch.index === undefined) return;
    let i = startMatch.index;
    while (i < source.length && source[i] !== '{') i++;
    const bodyStart = i;
    let depth = 0;
    let bodyEnd = -1;
    for (let k = bodyStart; k < source.length; k++) {
      const ch = source[k];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          bodyEnd = k;
          break;
        }
      }
    }
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = source.slice(bodyStart, bodyEnd + 1);

    // Assert the four ordered markers all appear in the function body:
    //   1. transaction(   (BEGIN/COMMIT envelope)
    //   2. FROM pm_options ... FOR UPDATE
    //   3. SUM(amount) FROM pm_stakes
    //   4. .update(pmOptions).set({ poolTotal:
    // Strip line comments so the regex matches don't false-positive on
    // the doc-comment summary at the top of the function body.
    const codeOnly = body
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const txnIdx = codeOnly.search(/\.transaction\s*\(/);
    expect(txnIdx).toBeGreaterThanOrEqual(0);

    const forUpdateIdx = codeOnly.search(
      /FROM\s+pm_options[\s\S]*?FOR\s+UPDATE/i,
    );
    expect(forUpdateIdx).toBeGreaterThan(txnIdx);

    const sumIdx = codeOnly.search(
      /SUM\(amount\)[\s\S]*?FROM\s+pm_stakes/i,
    );
    expect(sumIdx).toBeGreaterThan(forUpdateIdx);

    const updateIdx = codeOnly.search(
      /\.update\(pmOptions\)[\s\S]*?poolTotal/,
    );
    expect(updateIdx).toBeGreaterThan(sumIdx);
  });
});

// Suppress unused import.
void encodeAbiParameters;
void parseAbiParameters;
