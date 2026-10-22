// #214 S1: Invariant R, the roster rule (NOTIFICATIONS_PLAN r8 §3.2 "Recipient history"; §8 S1 "Roster", Codex R2
// F1), for pools and rounds, plus the Rounds scan itself (§3.2(2)).
import { afterEach, describe, expect, it } from 'vitest';

import { GateClosed, runLeaderboardIndexerOnce } from '@/lib/leaderboard/indexer';
import { runRoundsScanOnce } from '@/lib/notifications/rounds-scan';

import {
  betLog,
  CHAIN,
  createNotifyDb,
  cursorOf,
  enteredLog,
  mockChain,
  noSleep,
  notificationsOf,
  notifiedThrough,
  refundedLog,
  resolvedLog,
  ROUNDS,
  setCursor,
  settledLog,
  tiedLog,
  V4,
  walletAccount,
  type Market,
  type MockChain,
  type NotifyDb,
  type RoundState,
} from './harness';

const F = 100_000;
const HEAD = F + 216;
const ALICE = '0xa11ce00000000000000000000000000000000001';
const CAROL = '0xca401000000000000000000000000000000000c3';
const DAVE = '0xdae0000000000000000000000000000000000d4e';

let t: NotifyDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const market = (over: Partial<Market>): Market => ({
  creator: DAVE,
  totalYes: 1_000_000n,
  totalNo: 0n,
  yesBettorCount: 1,
  noBettorCount: 0,
  outcome: 3,
  resolved: true,
  creatorFeeBpsSnapshot: 0,
  ...over,
});

const runV4 = (chain: MockChain, over: Partial<Parameters<typeof runLeaderboardIndexerOnce>[0]> = {}) =>
  runLeaderboardIndexerOnce({ db: t!.db as never, publicClient: chain.client, chainId: CHAIN, contracts: [V4], chunkSize: 100, notifyFromBlock: F, sleep: noSleep, ...over }).then(
    (r) => r.contracts[0],
  );

const runRounds = (chain: MockChain, over: Partial<Parameters<typeof runRoundsScanOnce>[0]> = {}) =>
  runRoundsScanOnce({ db: t!.db as never, publicClient: chain.client, contractAddress: ROUNDS, chainId: CHAIN, chunkSize: 1_000, notifyFromBlock: F, sleep: noSleep, ...over });

async function fresh() {
  t = await createNotifyDb();
  await setCursor(t, V4.address, F - 1);
  return t;
}

describe('roster: pools (beta shape, V4 cursor at F − 1)', () => {
  it("Codex's test: a bet before the floor, the resolution after it, exactly one row for the bettor", async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    await walletAccount(db, CAROL);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(5, ALICE, true, F - 10), resolvedLog(5, 3, F + 10)],
      markets: new Map([['5', market({})]]),
      bets: new Map([[`5:${ALICE}`, [1_000_000n, 0n]]]),
    });
    const r = await runV4(chain);
    expect(r.rosterFromChain).toBe(1);
    expect(await notificationsOf(db, alice)).toEqual([
      expect.objectContaining({ kind: 'claim', dedupe_key: `pool:${V4.address}:5:result`, data: { t: 'pool', id: '5', outcome: 'refund', why: 'refund' } }),
    ]);
    expect((await notifiedThrough(db, V4.address))!).toBeGreaterThanOrEqual(F + 10);
    await runV4(chain);
    expect(await notificationsOf(db)).toHaveLength(1);
  });

  it('mixed roster: the ledger is short on YES, so positions are read; each bettor gets exactly one row', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const carol = await walletAccount(db, CAROL);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(6, ALICE, true, F - 10), betLog(6, CAROL, false, F + 2), resolvedLog(6, 1, F + 10)],
      markets: new Map([['6', market({ outcome: 1, noBettorCount: 1, totalNo: 1_000_000n })]]),
      bets: new Map([
        [`6:${ALICE}`, [1_000_000n, 0n]],
        [`6:${CAROL}`, [0n, 1_000_000n]],
      ]),
    });
    const r = await runV4(chain);
    expect(r.rosterFromChain).toBe(1);
    expect((await notificationsOf(db, alice)).map((n) => [n.kind, n.data])).toEqual([['claim', { t: 'pool', id: '6', outcome: 'yes', why: 'won' }]]);
    expect((await notificationsOf(db, carol)).map((n) => [n.kind, n.data])).toEqual([['result', { t: 'pool', id: '6', outcome: 'yes', side: 'no' }]]);
  });

  it('complete ledger: the same rows, and no getUserBet call', async () => {
    const db = await fresh();
    await walletAccount(db, ALICE);
    await walletAccount(db, CAROL);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(6, ALICE, true, F + 1), betLog(6, CAROL, false, F + 2), resolvedLog(6, 1, F + 10)],
      markets: new Map([['6', market({ outcome: 1, noBettorCount: 1, totalNo: 1_000_000n })]]),
    });
    const r = await runV4(chain);
    expect(chain.calls.positionReads).toBe(0);
    expect(r.rosterFromChain).toBe(0);
    expect(await notificationsOf(db)).toHaveLength(2);
  });

  it('a failed position read holds the event back; the next run gives exactly one row', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(5, ALICE, true, F - 10), resolvedLog(5, 3, F + 10)],
      markets: new Map([['5', market({})]]),
      bets: new Map([[`5:${ALICE}`, [1_000_000n, 0n]]]),
      failPositionReads: 3, // the first try and both retries
    });
    const r1 = await runV4(chain);
    expect(r1.mutex).toBe('error');
    expect(r1.upToDate).toBe(false);
    expect(await notificationsOf(db, alice)).toHaveLength(0);
    expect((await notifiedThrough(db, V4.address)) ?? F - 1).toBeLessThan(F + 10);
    const r2 = await runV4(chain);
    expect(r2.upToDate).toBe(true);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
  });

  it('no account, no row: the read asks only for account addresses', async () => {
    const db = await fresh();
    const alice = await walletAccount(db, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(5, ALICE, true, F - 10), betLog(5, DAVE, false, F - 9), resolvedLog(5, 1, F + 10)],
      markets: new Map([['5', market({ outcome: 1, noBettorCount: 1, totalNo: 1_000_000n })]]),
      bets: new Map([
        [`5:${ALICE}`, [1_000_000n, 0n]],
        [`5:${DAVE}`, [0n, 1_000_000n]],
      ]),
    });
    await runV4(chain);
    expect(chain.calls.positionAddresses).toEqual([ALICE]);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
    expect(await notificationsOf(db)).toHaveLength(1);
  });

  it('production shape: no cursor seeded, the scan starts at the deploy block, the ledger matches, no getUserBet', async () => {
    t = await createNotifyDb();
    const db = t;
    const alice = await walletAccount(db, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [betLog(5, ALICE, true, F - 10), resolvedLog(5, 3, F + 10)],
      markets: new Map([['5', market({})]]),
    });
    const r = await runV4(chain, { chunkSize: 10_000 });
    expect(r.fromBlock).toBe(V4.deployBlock);
    expect(chain.calls.positionReads).toBe(0);
    expect(await notificationsOf(db, alice)).toHaveLength(1);
  });
});

const round = (over: Partial<RoundState>): RoundState => ({ status: 2, outcome: 1, refundReason: 0, upEntrants: 1, downEntrants: 1, ...over });

describe('rounds scan', () => {
  it('no row and no floor: nothing is scanned, noFloor is reported, and no state row is created', async () => {
    t = await createNotifyDb();
    const chain = mockChain({ head: HEAD, logs: [] });
    const r = await runRounds(chain, { notifyFromBlock: null });
    expect(r.noFloor).toBe(true);
    expect(r.mutex).toBe('no-floor');
    expect(chain.calls.getLogs).toHaveLength(0);
    expect(await cursorOf(t, ROUNDS)).toBeNull();
  });

  it('Entered and RoundSettled in the same batch: the winner claim (won), the loser result; a top-up is one entrant row', async () => {
    t = await createNotifyDb();
    const alice = await walletAccount(t, ALICE);
    const carol = await walletAccount(t, CAROL);
    const chain = mockChain({
      head: HEAD,
      logs: [enteredLog(9, ALICE, 1, F + 1), enteredLog(9, ALICE, 1, F + 2), enteredLog(9, CAROL, 2, F + 3), settledLog(9, 1, F + 10)],
      rounds: new Map([['9', round({})]]),
    });
    const r = await runRounds(chain);
    expect(r.fromBlock).toBe(F - 60_000); // F here is NOTIFY_FROM_BLOCK, so the floor is (F − 1) + 1 − 60,000
    expect(r.upToDate).toBe(true);
    expect(chain.calls.positionReads).toBe(0);
    expect((await t.client.query(`SELECT count(*)::int AS c FROM mako_round_entrants WHERE account = $1`, [ALICE])).rows[0]).toEqual({ c: 1 });
    expect((await notificationsOf(t, alice)).map((n) => [n.kind, n.dedupe_key, n.data])).toEqual([
      ['claim', `round:${ROUNDS}:9:result`, { t: 'round', id: '9', outcome: 'up', why: 'won' }],
    ]);
    expect((await notificationsOf(t, carol)).map((n) => [n.kind, n.data])).toEqual([['result', { t: 'round', id: '9', outcome: 'up', side: 'down' }]]);
  });

  it('across batches: entrants from one run, the settlement in a later run', async () => {
    t = await createNotifyDb();
    const alice = await walletAccount(t, ALICE);
    const chain = mockChain({ head: HEAD, logs: [enteredLog(9, ALICE, 2, F + 1)], rounds: new Map([['9', round({ outcome: 2, upEntrants: 0 })]]) });
    await runRounds(chain);
    chain.state.head = HEAD + 5_000;
    chain.state.logs.push(settledLog(9, 2, HEAD + 100));
    const r = await runRounds(chain);
    expect(r.upToDate).toBe(true);
    expect(chain.calls.positionReads).toBe(0);
    expect((await notificationsOf(t, alice)).map((n) => n.data)).toEqual([{ t: 'round', id: '9', outcome: 'down', why: 'won' }]);
  });

  it('a tie gives exactly one notification per entrant (RoundTied is not fetched; RoundRefunded(Tie) is)', async () => {
    t = await createNotifyDb();
    const alice = await walletAccount(t, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [enteredLog(9, ALICE, 1, F + 1), tiedLog(9, F + 10), refundedLog(9, 2, F + 10)],
      rounds: new Map([['9', round({ status: 3, outcome: 0, refundReason: 2, downEntrants: 0 })]]),
    });
    await runRounds(chain);
    expect((await notificationsOf(t, alice)).map((n) => [n.kind, n.data])).toEqual([['claim', { t: 'round', id: '9', outcome: 'refund', why: 'refund', reason: 'tie' }]]);
  });

  it('placeholder: after a failed first batch leaves the state row at 0, the next run starts at the floor, not block 0', async () => {
    t = await createNotifyDb();
    const chain = mockChain({ head: HEAD, logs: [] });
    const getLogs = chain.client.getLogs.bind(chain.client);
    (chain.client as unknown as { getLogs: unknown }).getLogs = async () => {
      throw new GateClosed();
    };
    const r1 = await runRounds(chain);
    expect(r1.mutex).toBe('error');
    expect(await cursorOf(t, ROUNDS)).toBe(0);
    (chain.client as unknown as { getLogs: unknown }).getLogs = getLogs;
    const r2 = await runRounds(chain);
    expect(r2.fromBlock).toBe(F - 60_000);
    expect(r2.upToDate).toBe(true);
    expect(Math.min(...chain.calls.getLogs.map((c) => c.from))).toBe(F - 60_000);
  });

  it('roster: an entry older than the 60,000-block lookback is read from the contract (stakeOf)', async () => {
    t = await createNotifyDb();
    const alice = await walletAccount(t, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [enteredLog(9, ALICE, 1, F - 60_005), settledLog(9, 1, F + 10)],
      rounds: new Map([['9', round({ downEntrants: 0 })]]),
      stakes: new Map([[`9:${ALICE}`, { side: 1, amount: 1_000_000n }]]),
    });
    const r = await runRounds(chain);
    expect(r.rosterFromChain).toBe(1);
    expect((await notificationsOf(t, alice)).map((n) => n.data)).toEqual([{ t: 'round', id: '9', outcome: 'up', why: 'won' }]);
  });

  it('roster: entrants pruned after 9 days are read from the contract', async () => {
    t = await createNotifyDb();
    const alice = await walletAccount(t, ALICE);
    const chain = mockChain({
      head: HEAD,
      logs: [enteredLog(9, ALICE, 1, F + 1)],
      rounds: new Map([['9', round({ status: 3, refundReason: 1, downEntrants: 0 })]]),
      stakes: new Map([[`9:${ALICE}`, { side: 1, amount: 1_000_000n }]]),
    });
    await runRounds(chain);
    await t.client.query(`UPDATE mako_round_entrants SET created_at = now() - interval '10 days'`);
    await t.client.query(`DELETE FROM mako_round_entrants WHERE created_at < now() - interval '9 days'`);
    chain.state.head = HEAD + 1_000;
    chain.state.logs.push(refundedLog(9, 1, HEAD + 100));
    const r = await runRounds(chain);
    expect(r.rosterFromChain).toBe(1);
    expect((await notificationsOf(t, alice)).map((n) => n.data)).toEqual([{ t: 'round', id: '9', outcome: 'refund', why: 'refund', reason: 'one_sided' }]);
  });
});
