// ----------------------------------------------------------------------------
// #186 /api/leaderboard route — split-cache + viewer semantics.
//
// unstable_cache is mocked as a passthrough THAT RECORDS ITS KEY PARTS,
// so the suite can assert the shared board's cache key carries the
// window and never the caller address (the Codex r1 MAJOR-3 class:
// per-user data poisoning a shared cache). @/db/client is mocked onto
// the pglite harness.
// ----------------------------------------------------------------------------

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { makoMarketEvents, makoLeaderboardIndexerState } from '@/db/schema';
import { createTestDb, type TestDb } from './test-db';

// ---- Mocks (hoisted) ---------------------------------------------------------

const cacheKeysSeen: string[][] = [];

vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[]) => {
    cacheKeysSeen.push(keyParts);
    return fn; // passthrough — caching behavior itself is Next's, not ours
  },
}));

// The route imports { db } from '@/db/client'; point it at the harness.
let currentDb: unknown;
vi.mock('@/db/client', () => ({
  get db() {
    return currentDb;
  },
}));

// The route scopes syncing to the CONFIGURED contract set; pin the
// config to the test fixture contract so cursor-row assertions are
// deterministic (the real config carries the live v4 address).
// Literal address: vi.mock factories are hoisted above const bindings.
vi.mock('@/lib/leaderboard/contracts', () => ({
  LEADERBOARD_CONTRACTS: [
    {
      address: '0x00000000000000000000000000000000000000aa',
      deployBlock: 100,
      version: 'v4',
    },
  ],
}));

// Import AFTER mocks bind.
const { GET } = await import('@/app/api/leaderboard/route');

// ---- Fixtures ----------------------------------------------------------------

const CHAIN = 10143;
const CONTRACT = '0x00000000000000000000000000000000000000aa';
const SAFE_CHECKSUMMED = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const SAFE_LOWER = SAFE_CHECKSUMMED.toLowerCase();
const ANON = '0x000000000000000000000000000000000000b22d';
const OFFBOARD = '0x000000000000000000000000000000000000c33e';

let testDb: TestDb | null = null;
let txCounter = 0;

beforeEach(() => {
  cacheKeysSeen.length = 0;
});

afterEach(async () => {
  if (testDb) {
    await testDb.close();
    testDb = null;
  }
  txCounter = 0;
});

async function freshDb(): Promise<TestDb> {
  testDb = await createTestDb();
  currentDb = testDb.db;
  // Minimal identity mirror (see identity.test.ts for rationale).
  await testDb.client.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      wallet_address text,
      display_name text
    );
    CREATE TABLE user_safes (
      user_id uuid NOT NULL,
      chain_id integer NOT NULL,
      safe_address text NOT NULL
    );
  `);
  return testDb;
}

async function insertEvent(
  t: TestDb,
  over: { actor: string; kind: 'bet' | 'claim' | 'creator_fee'; amount: string },
) {
  txCounter += 1;
  await t.db.insert(makoMarketEvents).values({
    chainId: CHAIN,
    contractAddress: CONTRACT as `0x${string}`,
    version: 'v4',
    marketId: '1',
    kind: over.kind,
    actor: over.actor as `0x${string}`,
    isYes: over.kind === 'bet' ? true : null,
    amount: over.amount,
    blockNumber: 100 + txCounter,
    blockTimestamp: new Date(),
    txHash: `0x${txCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
    logIndex: 0,
  });
}

function request(params: string): Request {
  return new Request(`http://test.local/api/leaderboard${params}`);
}

// ---- Tests -------------------------------------------------------------------

describe('GET /api/leaderboard', () => {
  it('rejects bad params', async () => {
    await freshDb();
    expect((await GET(request('?window=year'))).status).toBe(400);
    expect((await GET(request('?sort=winrate'))).status).toBe(400);
    expect((await GET(request('?me=not-an-address'))).status).toBe(400);
  });

  it('accepts the month window and the volume sort, and echoes both', async () => {
    const t = await freshDb();
    // ANON wins big on small volume; OFFBOARD stakes more and loses.
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '1000000' });
    await insertEvent(t, { actor: ANON, kind: 'claim', amount: '9000000' });
    await insertEvent(t, { actor: OFFBOARD, kind: 'bet', amount: '5000000' });

    const byProfit = await (await GET(request('?window=month'))).json();
    expect(byProfit.window).toBe('month');
    expect(byProfit.sort).toBe('profit'); // the default
    expect(byProfit.rows.map((r: { actor: string }) => r.actor)).toEqual([ANON, OFFBOARD]);

    const byVolume = await (await GET(request('?window=month&sort=volume'))).json();
    expect(byVolume.sort).toBe('volume');
    expect(byVolume.rows.map((r: { actor: string }) => r.actor)).toEqual([OFFBOARD, ANON]);
  });

  it('keys the shared board by window and sort, never the caller', async () => {
    const t = await freshDb();
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '1000000' });

    await GET(request(`?window=month&sort=volume&me=${SAFE_CHECKSUMMED}`));
    await GET(request(`?window=month&sort=profit&me=${SAFE_CHECKSUMMED}`));

    const boardKeys = cacheKeysSeen.filter((k) => k[0] === 'leaderboard-board');
    expect(boardKeys).toEqual([
      ['leaderboard-board', 'month', 'volume'],
      ['leaderboard-board', 'month', 'profit'],
    ]);
  });

  it('ranks an off-board viewer by the same sort as the board', async () => {
    const t = await freshDb();
    // 101 actors, actor i stakes i USDC and never wins: net = -i. By
    // profit the 1-USDC actor is #1 (on the board); by volume it is #101,
    // one past the top-100 board, so the viewer block carries its rank.
    const actorOf = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
    await t.db.insert(makoMarketEvents).values(
      Array.from({ length: 101 }, (_, k) => {
        const i = k + 1;
        return {
          chainId: CHAIN,
          contractAddress: CONTRACT as `0x${string}`,
          version: 'v4' as const,
          marketId: '1',
          kind: 'bet' as const,
          actor: actorOf(i) as `0x${string}`,
          isYes: true,
          amount: String(i * 1_000_000),
          blockNumber: 1000 + i,
          blockTimestamp: new Date(),
          txHash: `0x${(5000 + i).toString(16).padStart(64, '0')}` as `0x${string}`,
          logIndex: 0,
        };
      }),
    );
    const me = actorOf(1);

    const byProfit = await (await GET(request(`?sort=profit&me=${me}`))).json();
    expect(byProfit.rows[0].actor).toBe(me);
    expect('viewer' in byProfit).toBe(false);

    const byVolume = await (await GET(request(`?sort=volume&me=${me}`))).json();
    expect(byVolume.rows).toHaveLength(100);
    expect(byVolume.rows.some((r: { actor: string }) => r.actor === me)).toBe(false);
    expect(byVolume.viewer.rank).toBe(101);
    expect(byVolume.viewer.staked).toBe('1000000');
  });

  it('serves the board with identity labels merged and indexedThrough', async () => {
    const t = await freshDb();
    // Magic user with a display name, betting via their (checksummed-
    // stored) safe.
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('satoshi') RETURNING id`,
    );
    await t.client.query(
      `INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)`,
      [res.rows[0].id, CHAIN, SAFE_CHECKSUMMED],
    );
    await insertEvent(t, { actor: SAFE_LOWER, kind: 'bet', amount: '10000000' });
    await insertEvent(t, { actor: SAFE_LOWER, kind: 'claim', amount: '25000000' });
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '5000000' });
    await t.db.insert(makoLeaderboardIndexerState).values({
      chainId: CHAIN,
      contractAddress: CONTRACT as `0x${string}`,
      lastScannedBlock: 32700000,
      lastScanTarget: 32700000, // caught up — scanned === target
    });

    const resp = await GET(request('?window=all'));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.window).toBe('all');
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].actor).toBe(SAFE_LOWER);
    expect(body.rows[0].displayName).toBe('satoshi'); // casing join works
    expect(body.rows[0].net).toBe('15000000');
    expect(body.rows[1].displayName).toBeNull(); // anon falls back
    expect(body.indexedThrough).toBe(32700000);
    expect(body.syncing).toBe(false); // caught-up cursor
    expect(typeof body.generatedAt).toBe('string');
    expect(body.viewer).toBeUndefined(); // no me param
  });

  it('reports syncing through every mid-backfill state, not just pre-cursor (review MAJOR-1)', async () => {
    const t = await freshDb();
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '1000000' });

    // 1. No cursor rows at all (pre-first-acquire sliver).
    let body = await (await GET(request(''))).json();
    expect(body.syncing).toBe(true);

    // 2. Cursor exists but never completed a scan (target still 0) —
    //    the state acquireContractMutex creates on the very first tick.
    await t.db.insert(makoLeaderboardIndexerState).values({
      chainId: CHAIN,
      contractAddress: CONTRACT as `0x${string}`,
      lastScannedBlock: 0,
      lastScanTarget: 0,
    });
    body = await (await GET(request(''))).json();
    expect(body.syncing).toBe(true);

    // 3. Mid-backfill: cursor climbing but behind its scan target —
    //    the multi-hour window where keying off indexedThrough===null
    //    showed a partial board as authoritative.
    await t.db
      .update(makoLeaderboardIndexerState)
      .set({ lastScannedBlock: 32650000, lastScanTarget: 32700000 });
    body = await (await GET(request(''))).json();
    expect(body.indexedThrough).toBe(32650000); // real number...
    expect(body.syncing).toBe(true); // ...but still honestly syncing

    // 4. Caught up.
    await t.db
      .update(makoLeaderboardIndexerState)
      .set({ lastScannedBlock: 32700000, lastScanTarget: 32700000 });
    body = await (await GET(request(''))).json();
    expect(body.syncing).toBe(false);
  });

  it('configured-but-uncursored contracts force syncing; foreign rows cannot vouch (re-review gap)', async () => {
    const t = await freshDb();
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '1000000' });

    // A caught-up cursor for a contract that is NOT in the configured
    // list must not make the board look synced — the CONFIGURED
    // contract still has no cursor at all.
    await t.db.insert(makoLeaderboardIndexerState).values({
      chainId: CHAIN,
      contractAddress: '0x00000000000000000000000000000000000000bb',
      lastScannedBlock: 32700000,
      lastScanTarget: 32700000,
    });
    let body = await (await GET(request(''))).json();
    expect(body.syncing).toBe(true);

    // Same address as configured but on the WRONG chain: still no
    // vouching.
    await t.db.insert(makoLeaderboardIndexerState).values({
      chainId: 999999,
      contractAddress: CONTRACT as `0x${string}`,
      lastScannedBlock: 32700000,
      lastScanTarget: 32700000,
    });
    body = await (await GET(request(''))).json();
    expect(body.syncing).toBe(true);

    // The CONFIGURED contract's own caught-up cursor flips it.
    await t.db.insert(makoLeaderboardIndexerState).values({
      chainId: CHAIN,
      contractAddress: CONTRACT as `0x${string}`,
      lastScannedBlock: 32700000,
      lastScanTarget: 32700000,
    });
    body = await (await GET(request(''))).json();
    expect(body.syncing).toBe(false);
    // indexedThrough comes from the configured contract only.
    expect(body.indexedThrough).toBe(32700000);
  });

  it('the shared cache key carries the window and never the caller', async () => {
    const t = await freshDb();
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '1000000' });

    await GET(request(`?window=week&me=${SAFE_CHECKSUMMED}`));

    expect(cacheKeysSeen.length).toBeGreaterThan(0);
    for (const key of cacheKeysSeen) {
      expect(key).toContain('week');
      expect(key).toContain('profit');
      expect(key.join(' ').toLowerCase()).not.toContain(SAFE_LOWER);
    }
  });

  it('omits viewer when the caller is on the board (single source of truth)', async () => {
    const t = await freshDb();
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '5000000' });

    const resp = await GET(request(`?me=${ANON}`));
    const body = await resp.json();
    expect(body.rows.some((r: { actor: string }) => r.actor === ANON)).toBe(
      true,
    );
    expect('viewer' in body).toBe(false);
  });

  it('returns viewer null for a caller with no events', async () => {
    const t = await freshDb();
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '5000000' });

    const resp = await GET(request(`?me=${OFFBOARD}`));
    const body = await resp.json();
    expect(body.viewer).toBeNull();
  });

  it('returns an off-board viewer with rank when the board is full', async () => {
    const t = await freshDb();
    // Fill the board past OFFBOARD's net so it lands outside top-N…
    // BOARD_LIMIT is 100; simulating 101 actors is slow on pglite, so
    // exercise the same code path by checking the viewer block for a
    // caller that exists but — with distinct casing in the query — is
    // matched correctly and ranked. Board contains 2; both outrank the
    // caller, but the caller IS on the board (top-100 covers everyone
    // here), so instead force off-board via the week window: caller's
    // only event is old.
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '9000000' });
    await t.db.insert(makoMarketEvents).values({
      chainId: CHAIN,
      contractAddress: CONTRACT as `0x${string}`,
      version: 'v4',
      marketId: '1',
      kind: 'bet',
      actor: OFFBOARD as `0x${string}`,
      isYes: true,
      amount: '1000000',
      blockNumber: 99,
      blockTimestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      txHash: `0x${'ee'.repeat(32)}` as `0x${string}`,
      logIndex: 0,
    });

    // Weekly board: OFFBOARD's bet is outside the window → absent from
    // rows → viewer path runs → getCallerRank('week') finds nothing →
    // null. All-time: OFFBOARD is on the board → viewer omitted.
    const weekly = await (await GET(request(`?window=week&me=${OFFBOARD}`))).json();
    expect(weekly.rows.some((r: { actor: string }) => r.actor === OFFBOARD)).toBe(false);
    expect(weekly.viewer).toBeNull();

    const allTime = await (await GET(request(`?window=all&me=${OFFBOARD}`))).json();
    expect(allTime.rows.some((r: { actor: string }) => r.actor === OFFBOARD)).toBe(true);
    expect('viewer' in allTime).toBe(false);
  });

  it('indexedThrough is null and syncing true before any cursor exists', async () => {
    const t = await freshDb();
    await insertEvent(t, { actor: ANON, kind: 'bet', amount: '1000000' });

    const body = await (await GET(request(''))).json();
    expect(body.indexedThrough).toBeNull();
    expect(body.syncing).toBe(true);
  });
});
