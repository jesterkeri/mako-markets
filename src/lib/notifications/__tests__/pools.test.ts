// #214 S1: pool results through the V4 scan (NOTIFICATIONS_PLAN r8 §3.2(1), §3.2 "Scanning", "History guard",
// "Recipient history"; tests §8 S1). Real migrations 0000..0020 on pglite, a mock chain at 'finalized'.
import { afterEach, describe, expect, it } from 'vitest';

import { runLeaderboardIndexerOnce } from '@/lib/leaderboard/indexer';

import {
  betLog,
  CHAIN,
  createNotifyDb,
  cursorOf,
  emailAccount,
  mockChain,
  noSleep,
  notificationsOf,
  notifiedThrough,
  resolvedLog,
  setCursor,
  V4,
  walletAccount,
  type Market,
  type MockChain,
  type NotifyDb,
} from './harness';

const F = 1_000; // NOTIFY_FROM_BLOCK; the floor is F − 1
const HEAD = 1_216; // target 1,200
const ALICE = '0xa11ce00000000000000000000000000000000001';
const CAROL = '0xca401000000000000000000000000000000000c3';
const DAVE = '0xdae0000000000000000000000000000000000d4e';
const CREATOR = '0xc4ea7040000000000000000000000000000000c1';
const SAFE_CHECKSUMMED = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';

let t: NotifyDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const market = (over: Partial<Market>): Market => ({
  creator: CREATOR,
  totalYes: 1_000_000n,
  totalNo: 1_000_000n,
  yesBettorCount: 1,
  noBettorCount: 1,
  outcome: 1,
  resolved: true,
  creatorFeeBpsSnapshot: 0,
  ...over,
});

const run = (chain: MockChain, over: Partial<Parameters<typeof runLeaderboardIndexerOnce>[0]> = {}) =>
  runLeaderboardIndexerOnce({
    db: t!.db as never,
    publicClient: chain.client,
    chainId: CHAIN,
    contracts: [V4],
    chunkSize: 100,
    notifyFromBlock: F,
    sleep: noSleep,
    ...over,
  }).then((r) => r.contracts[0]);

async function fresh() {
  t = await createNotifyDb();
  await setCursor(t, V4.address, F - 1); // beta shape: the V4 cursor seeded at B − 1
  return t;
}

describe('pool results', () => {
  it('YES pool: the winner gets claim (won), the loser result, the creator claim (creator earnings)', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const carol = await walletAccount(db, CAROL);
    const creator = await walletAccount(db, CREATOR);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(7, ALICE, true, F + 2), betLog(7, CAROL, false, F + 3), resolvedLog(7, 1, F + 10)],
      markets: new Map([['7', market({ creatorFeeBpsSnapshot: 200, totalYes: 5_000_000n, totalNo: 5_000_000n })]]),
    });
    const r = await run(chain);
    expect(r.error).toBeUndefined();
    expect(r.upToDate).toBe(true);
    expect(r.rosterFromChain).toBe(0);
    expect(chain.calls.positionReads).toBe(0);
    const a = await notificationsOf(db, alice);
    expect(a).toEqual([expect.objectContaining({ kind: 'claim', dedupe_key: `pool:${V4.address}:7:result`, data: { t: 'pool', id: '7', outcome: 'yes', why: 'won' } })]);
    expect(await notificationsOf(db, carol)).toEqual([
      expect.objectContaining({ kind: 'result', data: { t: 'pool', id: '7', outcome: 'yes', side: 'no' } }),
    ]);
    expect(await notificationsOf(db, creator)).toEqual([
      expect.objectContaining({ kind: 'claim', dedupe_key: `pool:${V4.address}:7:creator`, data: { t: 'pool', id: '7', outcome: 'yes', why: 'creator' } }),
    ]);
    expect(await notifiedThrough(db, V4.address)).toBeGreaterThanOrEqual(F + 10);
  });

  it('REFUND gives every bettor claim (refund); bets on both sides give claim (won); no account, no row', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const carol = await walletAccount(db, CAROL);
    const chain = mockChain({
      head: HEAD,
      logs: [
        betLog(8, ALICE, true, F + 2),
        betLog(8, DAVE, false, F + 3),
        resolvedLog(8, 3, F + 10),
        betLog(9, CAROL, true, F + 4),
        betLog(9, CAROL, false, F + 5),
        resolvedLog(9, 2, F + 11),
      ],
      markets: new Map([
        ['8', market({ outcome: 3 })],
        ['9', market({ outcome: 2, yesBettorCount: 1, noBettorCount: 1 })],
      ]),
    });
    await run(chain);
    expect((await notificationsOf(db, alice)).map((n) => n.data)).toEqual([{ t: 'pool', id: '8', outcome: 'refund', why: 'refund' }]);
    expect((await notificationsOf(db, carol)).map((n) => [n.kind, n.data])).toEqual([['claim', { t: 'pool', id: '9', outcome: 'no', why: 'won' }]]);
    // Dave has no account: nothing anywhere names him.
    expect((await notificationsOf(db)).length).toBe(2);
  });

  it('a checksummed Safe matches its lowercase on-chain bettor', async () => {
    const db = await fresh();
    const id = await emailAccount(db, SAFE_CHECKSUMMED);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(3, SAFE_CHECKSUMMED, true, F + 2), resolvedLog(3, 3, F + 10)],
      markets: new Map([['3', market({ outcome: 3, noBettorCount: 0 })]]),
    });
    await run(chain);
    expect(await notificationsOf(db, id)).toHaveLength(1);
  });

  it('a kind switched off gives no row; a stored non-boolean reads as the default and never fails the batch', async () => {
    const db = await fresh();
    const off = await walletAccount(db, ALICE);
    const weird = await walletAccount(db, CAROL);
    await db.client.query(`UPDATE users SET notification_prefs = '{"kinds":{"claim":false}}' WHERE id = $1`, [off]);
    await db.client.query(`UPDATE users SET notification_prefs = '{"kinds":{"claim":"yes"}}' WHERE id = $1`, [weird]);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(4, ALICE, true, F + 2), betLog(4, CAROL, true, F + 3), resolvedLog(4, 3, F + 10)],
      markets: new Map([['4', market({ outcome: 3, yesBettorCount: 2, noBettorCount: 0 })]]),
    });
    const r = await run(chain);
    expect(r.error).toBeUndefined();
    expect(await notificationsOf(db, off)).toHaveLength(0);
    expect(await notificationsOf(db, weird)).toHaveLength(1);
  });

  for (const [name, prefs] of [
    ['string claim', '{"kinds":{"claim":"yes"}}'],
    ['number claim', '{"kinds":{"claim":1}}'],
    ['null claim', '{"kinds":{"claim":null}}'],
    ['kinds array', '{"kinds":[]}'],
    ['top-level array', '[]'],
    ['top-level string', '"x"'],
    ['email string', '{"email":"no"}'],
  ] as const) {
    it(`a recipient whose prefs are ${name} does not stop the batch: rows land, the cursor moves, the default applies`, async () => {
      const db = await fresh();
      const id = await walletAccount(db, ALICE);
      await db.client.query(`UPDATE users SET notification_prefs = $2::jsonb WHERE id = $1`, [id, prefs]);
      const chain = mockChain({
        head: HEAD,
        logs: [betLog(4, ALICE, true, F + 2), resolvedLog(4, 3, F + 10)],
        markets: new Map([['4', market({ outcome: 3, noBettorCount: 0 })]]),
      });
      const r = await run(chain);
      expect(r.upToDate).toBe(true);
      expect(await notificationsOf(db, id)).toHaveLength(1);
      expect(await cursorOf(db, V4.address)).toBe(HEAD - 16);
    });
  }

  it('creator earnings only when the fee snapshot is above 0, the fee works out above 0, and it is not forfeited', async () => {
    const db = await fresh();
    const creator = await walletAccount(db, CREATOR);
    const chain = mockChain({
      head: HEAD,
      logs: [resolvedLog(1, 1, F + 10), resolvedLog(2, 1, F + 11), resolvedLog(5, 1, F + 12), resolvedLog(6, 1, F + 13)],
      markets: new Map([
        ['1', market({ creatorFeeBpsSnapshot: 0, yesBettorCount: 0, noBettorCount: 0 })], // MAKO pool snapshots 0
        ['2', market({ creatorFeeBpsSnapshot: 200, totalYes: 1n, totalNo: 1n, yesBettorCount: 0, noBettorCount: 0 })], // fee rounds to 0
        ['5', market({ creatorFeeBpsSnapshot: 200, totalYes: 1_000_000_000n, totalNo: 1n, yesBettorCount: 0, noBettorCount: 0 })], // forfeited
        ['6', market({ creatorFeeBpsSnapshot: 200, totalYes: 5_000_000n, totalNo: 5_000_000n, yesBettorCount: 0, noBettorCount: 0 })],
      ]),
    });
    await run(chain);
    const rows = await notificationsOf(db, creator);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`pool:${V4.address}:6:creator`]);
  });

  it('re-running the same blocks adds no duplicate; the U+0000 question is never read into a row', async () => {
    const db = await fresh();
    await walletAccount(db, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(4, ALICE, true, F + 2), resolvedLog(4, 3, F + 10)],
      markets: new Map([['4', market({ outcome: 3, noBettorCount: 0, question: `bad\u0000${'\u{1F600}'.repeat(50)}\u0001` })]]),
    });
    await run(chain);
    await setCursor(db, V4.address, F - 1);
    await db.client.query(`UPDATE notify_cursor SET notified_through = $1`, [F - 1]);
    await run(chain);
    const rows = await notificationsOf(db);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('bad');
  });

  it('a finalized re-read that disagrees fails the batch: nothing written, cursors stay, the next run notifies', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(4, ALICE, true, F + 2), resolvedLog(4, 3, F + 10)],
      markets: new Map([['4', market({ outcome: 3, resolved: false, noBettorCount: 0 })]]),
    });
    const r1 = await run(chain);
    expect(r1.mutex).toBe('error');
    expect(r1.upToDate).toBe(false);
    expect(await notificationsOf(db)).toHaveLength(0);
    expect(await cursorOf(db, V4.address)).toBe(F - 1);
    expect((await db.client.query(`SELECT count(*)::int AS c FROM mako_market_events`)).rows[0]).toEqual({ c: 0 });
    chain.state.markets.set('4', market({ outcome: 3, noBettorCount: 0 }));
    const r2 = await run(chain);
    expect(r2.upToDate).toBe(true);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
  });

  it('every 78-digit id and the longest enums fit the CHECKs', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const big = '9'.repeat(78);
    const chain = mockChain({
      head: HEAD,
      logs: [
        { ...betLog(0, ALICE, true, F + 2), args: { id: BigInt(big), user: ALICE, isYes: true, amount: 1n } },
        { ...resolvedLog(0, 1, F + 10), args: { id: BigInt(big), outcome: 1 } },
      ],
      markets: new Map([[big, market({ creator: ALICE, creatorFeeBpsSnapshot: 200, totalYes: 10_000_000n, totalNo: 10_000_000n, noBettorCount: 0 })]]),
    });
    const r = await run(chain);
    expect(r.error).toBeUndefined();
    expect((await notificationsOf(db, alice)).map((n) => n.dedupe_key).sort()).toEqual([
      `pool:${V4.address}:${big}:creator`,
      `pool:${V4.address}:${big}:result`,
    ]);
  });
});

describe('history guard and scanning', () => {
  it('no NOTIFY_FROM_BLOCK and no row: V4 still scans the ledger, reports noFloor, announces nothing', async () => {
    const db = await fresh();
    await walletAccount(db, ALICE);
    const chain = mockChain({ head: HEAD, logs: [betLog(4, ALICE, true, F + 2), resolvedLog(4, 3, F + 10)], markets: new Map([['4', market({ outcome: 3 })]]) });
    const r = await run(chain, { notifyFromBlock: null });
    expect(r.noFloor).toBe(true);
    expect(r.notifiedThrough).toBeNull();
    expect(r.upToDate).toBe(true);
    expect(await notificationsOf(db)).toHaveLength(0);
    expect(await notifiedThrough(db, V4.address)).toBeNull();
    expect((await db.client.query(`SELECT count(*)::int AS c FROM mako_market_events`)).rows[0]).toEqual({ c: 1 });
  });

  it('lowering NOTIFY_FROM_BLOCK after the row exists changes nothing; a re-seed after the prune announces nothing', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const chain = mockChain({ head: HEAD, logs: [betLog(4, ALICE, true, F + 2), resolvedLog(4, 3, F + 10)], markets: new Map([['4', market({ outcome: 3, noBettorCount: 0 })]]) });
    await run(chain);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
    const nt = await notifiedThrough(db, V4.address);
    // Age the rows past 90 days and prune as the route does, then the re-sync runbook: truncate both tables, re-seed.
    await db.client.query(`UPDATE notifications SET created_at = now() - interval '91 days'`);
    await db.client.query(`DELETE FROM notifications WHERE created_at < now() - interval '90 days'`);
    await db.client.query(`TRUNCATE mako_market_events, mako_leaderboard_indexer_state`);
    const r = await run(chain, { notifyFromBlock: 1 }); // lowered env, and a full scan from the deploy block
    expect(r.upToDate).toBe(true);
    expect(await notificationsOf(db)).toHaveLength(0);
    expect(await notifiedThrough(db, V4.address)).toBe(nt);
  });

  it('30 empty chunks: no batch transaction, one release, and the cursor and target equal the target', async () => {
    const db = await fresh();
    const chain = mockChain({ head: F - 1 + 3_000 + 16, logs: [] });
    const r = await run(chain);
    expect(r.upToDate).toBe(true);
    expect(chain.calls.getLogs).toHaveLength(30);
    const after = await db.client.query<{ last_scanned_block: number; last_scan_target: number; locked_at: string | null }>(
      `SELECT last_scanned_block, last_scan_target, locked_at FROM mako_leaderboard_indexer_state`,
    );
    expect(after.rows[0]).toEqual({ last_scanned_block: F - 1 + 3_000, last_scan_target: F - 1 + 3_000, locked_at: null });
    expect(await notifiedThrough(db, V4.address)).toBe(F - 1 + 3_000);
  });

  it('a batch whose finalized re-read fails stops the run before it; a later empty batch is never fetched', async () => {
    const db = await fresh();
    // Batch 1 [F, F+1999] empty; batch 2 [F+2000, F+3999] holds a resolution whose re-read disagrees; batch 3 empty.
    const chain = mockChain({
      head: F + 6_000 + 16,
      logs: [resolvedLog(4, 3, F + 2_500)],
      markets: new Map([['4', market({ outcome: 3, resolved: false, yesBettorCount: 0, noBettorCount: 0 })]]),
    });
    const r = await run(chain);
    expect(r.mutex).toBe('error');
    expect(await cursorOf(db, V4.address)).toBe(F + 1_999);
    expect(await notifiedThrough(db, V4.address)).toBe(F + 1_999);
    expect(chain.calls.getLogs.some((c) => c.from >= F + 4_000)).toBe(false);
    chain.state.markets.set('4', market({ outcome: 3, yesBettorCount: 0, noBettorCount: 0 }));
    chain.calls.getLogs.length = 0;
    const r2 = await run(chain);
    expect(r2.upToDate).toBe(true);
    expect(chain.calls.getLogs[0].from).toBe(F + 2_000);
  });

  it('a -32011 answer twice, then success, retries the same span without halving', async () => {
    await fresh();
    const chain = mockChain({ head: HEAD, logs: [] });
    let failures = 2;
    const inner = chain.client.getLogs.bind(chain.client);
    (chain.client as unknown as { getLogs: typeof inner }).getLogs = (async (a: Parameters<typeof inner>[0]) => {
      if (failures > 0) {
        failures -= 1;
        await inner(a);
        throw Object.assign(new Error('requests limited to 25/sec'), { code: -32011 });
      }
      return inner(a);
    }) as typeof inner;
    const r = await run(chain, { chunkSize: 1_000 });
    expect(r.upToDate).toBe(true);
    expect(chain.calls.getLogs.every((c) => c.to - c.from + 1 === 1_000 || c.to === HEAD - 16)).toBe(true);
    expect(chain.calls.getLogs[0]).toEqual(chain.calls.getLogs[1]);
  });

  it('a deadline mid-scan: the release writes the last empty-or-committed batch; the next run resumes, no block skipped', async () => {
    const db = await fresh();
    const chain = mockChain({ head: F - 1 + 6_000 + 16, logs: [] });
    let clock = 0;
    const fetch = chain.client.getLogs.bind(chain.client);
    (chain.client as unknown as { getLogs: typeof fetch }).getLogs = (async (a: Parameters<typeof fetch>[0]) => {
      clock += 100; // 20 chunks per batch: 2,000 ms per batch
      return fetch(a);
    }) as typeof fetch;
    // Budget 2,500 ms: batches 1 and 2 start before it, batch 3 (at 4,000 ms) does not.
    const r1 = await run(chain, { now: () => clock, timeBudgetMs: 2_500 });
    expect(r1.budgetExhausted).toBe(true);
    expect(r1.upToDate).toBe(false);
    expect(await cursorOf(db, V4.address)).toBe(F - 1 + 4_000);
    const r2 = await run(chain);
    expect(r2.upToDate).toBe(true);
    const counts = new Map<number, number>();
    for (const c of chain.calls.getLogs) for (let b = c.from; b <= c.to; b += 1) counts.set(b, (counts.get(b) ?? 0) + 1);
    for (let b = F; b <= F - 1 + 6_000; b += 1) expect(counts.get(b)).toBe(1); // every block exactly once
  });

  it('a scan with no deadline writes its cursor (and notified_through) at least once per 60 s', async () => {
    const db = await fresh();
    const chain = mockChain({ head: F - 1 + 10_000 + 16, logs: [] });
    let clock = 0;
    const writes: number[] = [];
    const fetch = chain.client.getLogs.bind(chain.client);
    (chain.client as unknown as { getLogs: typeof fetch }).getLogs = (async (a: Parameters<typeof fetch>[0]) => {
      clock += 1_000; // 20 s per batch
      return fetch(a);
    }) as typeof fetch;
    const r = await runLeaderboardIndexerOnce({
      db: db.db as never, publicClient: chain.client, chainId: CHAIN, contracts: [V4], chunkSize: 100, notifyFromBlock: F, sleep: noSleep,
      now: () => clock,
      onChunk: (i) => writes.push(i.chunkEnd),
    }).then((x) => x.contracts[0]);
    expect(r.upToDate).toBe(true);
    // 5 batches of 20 s: a write after the third batch (60 s) — at block F − 1 + 6,000.
    expect(writes).toContain(F - 1 + 6_000);
  });
});

describe('handoff (Invariant H, Codex R1 F1)', () => {
  async function oldStyleAdvance(db: NotifyDb, chain: MockChain, to: number) {
    // What the deployed 8f94ef9 indexer writes for blocks F..to: ledger rows and the cursor, no notification and no
    // notify_cursor row.
    for (const l of chain.state.logs.filter((x) => x.eventName === 'BetPlaced' && Number(x.blockNumber) <= to)) {
      await db.client.query(
        `INSERT INTO mako_market_events (chain_id, contract_address, version, market_id, kind, actor, is_yes, amount, block_number, block_timestamp, tx_hash, log_index)
         VALUES ($1, $2, 'v4', $3, 'bet', $4, $5, '1', $6, now(), $7, $8)`,
        [CHAIN, V4.address, String(l.args.id), String(l.args.user).toLowerCase(), l.args.isYes, Number(l.blockNumber), l.transactionHash, l.logIndex],
      );
    }
    await setCursor(db, V4.address, to);
  }

  it('an old-style advance across a MarketResolved above F is replayed: the bettors get their rows', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const carol = await walletAccount(db, CAROL);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(4, ALICE, true, F + 2), betLog(4, CAROL, false, F + 2), resolvedLog(4, 1, F + 10)],
      markets: new Map([['4', market({ outcome: 1 })]]),
    });
    await oldStyleAdvance(db, chain, F + 20);
    const ledgerBefore = (await db.client.query(`SELECT count(*)::int AS c FROM mako_market_events`)).rows[0];
    const r = await run(chain);
    expect(r.fromBlock).toBe(F);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
    expect(await notificationsOf(db, carol)).toHaveLength(1);
    expect(await notifiedThrough(db, V4.address)).toBeGreaterThanOrEqual(F + 20);
    expect((await db.client.query(`SELECT count(*)::int AS c FROM mako_market_events`)).rows[0]).toEqual(ledgerBefore);
    expect(await cursorOf(db, V4.address)).toBeGreaterThanOrEqual(F + 20);
  });

  it('cannot report success early: a disagreeing re-read leaves upToDate false and scannedTo below the event', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(4, ALICE, true, F + 2), resolvedLog(4, 3, F + 10)],
      markets: new Map([['4', market({ outcome: 3, resolved: false, noBettorCount: 0 })]]),
    });
    await oldStyleAdvance(db, chain, F + 20);
    const r = await run(chain);
    expect(r.upToDate).toBe(false);
    expect(r.scannedTo!).toBeLessThan(F + 10);
    expect((await notifiedThrough(db, V4.address)) ?? F - 1).toBeLessThan(F + 10);
    expect(await notificationsOf(db, alice)).toHaveLength(0);
    expect(await cursorOf(db, V4.address)).toBe(F + 20); // never moved back
    chain.state.markets.set('4', market({ outcome: 3, noBettorCount: 0 }));
    const r2 = await run(chain);
    expect(r2.upToDate).toBe(true);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
  });

  it('rollback: with the notify_cursor row already at F − 1 and the env var unset, the replay still notifies', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    await db.client.query(`INSERT INTO notify_cursor VALUES ($1, $2, $3)`, [CHAIN, V4.address, F - 1]);
    const chain = mockChain({ head: HEAD, logs: [betLog(4, ALICE, true, F + 2), resolvedLog(4, 3, F + 10)], markets: new Map([['4', market({ outcome: 3, noBettorCount: 0 })]]) });
    await oldStyleAdvance(db, chain, F + 20);
    const r = await run(chain, { notifyFromBlock: null });
    expect(r.noFloor).toBe(false);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
  });

  it('release after a replay whose first batch fails writes neither cursor; it clears locked_at only', async () => {
    const db = await fresh();
    const chain = mockChain({ head: HEAD, logs: [resolvedLog(4, 3, F + 10)], markets: new Map([['4', market({ outcome: 3, resolved: false })]]) });
    await setCursor(db, V4.address, F + 20);
    await run(chain);
    expect(await cursorOf(db, V4.address)).toBe(F + 20);
    expect(await notifiedThrough(db, V4.address)).toBeNull();
    expect((await db.client.query(`SELECT locked_at FROM mako_leaderboard_indexer_state`)).rows[0]).toEqual({ locked_at: null });
  });

  it('an out-of-date floor read fetches more, writes no duplicate, and leaves notified_through at the higher value', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const chain = mockChain({ head: HEAD, logs: [betLog(4, ALICE, true, F + 2), resolvedLog(4, 3, F + 10)], markets: new Map([['4', market({ outcome: 3, noBettorCount: 0 })]]) });
    await run(chain);
    const high = (await notifiedThrough(db, V4.address))!;
    // This scan reads F low; "another scan" raises notified_through between that read and the lock (here, at the
    // first RPC call after the lock).
    await db.client.query(`UPDATE notify_cursor SET notified_through = $1`, [F - 1]);
    const head = chain.client.getBlockNumber.bind(chain.client);
    (chain.client as unknown as { getBlockNumber: typeof head }).getBlockNumber = async () => {
      await db.client.query(`UPDATE notify_cursor SET notified_through = $1`, [high]);
      return head();
    };
    chain.calls.getLogs.length = 0;
    const r = await run(chain);
    expect(r.fromBlock).toBe(F);
    expect(chain.calls.getLogs.length).toBeGreaterThan(0);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
    expect(await notifiedThrough(db, V4.address)).toBe(high);
  });
});
