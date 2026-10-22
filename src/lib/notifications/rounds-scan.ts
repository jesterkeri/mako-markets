// ----------------------------------------------------------------------------
// #214 Notifications S1: the Rounds scan (NOTIFICATIONS_PLAN r8 §3.2(2)).
//
// The same scanContract as the V4 ledger (leaderboard/indexer.ts), pointed at MakoRoundsV1 through the same gate.
// Its cursor row lives in mako_leaderboard_indexer_state, which /api/leaderboard ignores (it scopes to the configured
// V4 contracts). `Entered` upserts mako_round_entrants whatever notified_through says (entrants first, terminal
// events after, within a batch). `RoundSettled` and `RoundRefunded` above notified_through are announced after a
// roundOf re-read at 'finalized' confirms them (status terminal, same outcome or reason); `RoundTied` is not fetched,
// because it is always followed by `RoundRefunded`.
//
// Rollout: the scan needs a floor F (the Rounds notify_cursor row, else NOTIFY_FROM_BLOCK − 1). It starts at
// max(F + 1 − 60,000, min(cursor, F) + 1), so the entrants of rounds already open are known. With no F it reports
// noFloor, takes no lock and creates no state row. The lookback is a saving, not a guarantee: a round whose entries
// are older, or whose entrant rows were pruned after 9 days, gets its roster from the contract (stakeOf).
// ----------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import { getAbiItem, type PublicClient } from 'viem';

import type { DbOrTx } from '@/db/client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import {
  LEADERBOARD_CONFIRMATIONS,
  LEADERBOARD_STALE_LOCK_MS,
  prefetchBlockTimestamps,
  scanContract,
  type BatchContext,
  type BatchWriteResult,
  type LeaderboardContractScanResult,
  type ScanLog,
} from '@/lib/leaderboard/indexer';
import { withRpcRetry } from '@/lib/leaderboard/rpc-gate';
import { normalizeAddressLower, bigintToNumber, numberToBigInt } from '@/lib/private-markets/normalize';
import { roundsAbi } from '@/lib/rounds-abi';
import { RefundReason, RoundOutcome, RoundStatus } from '@/lib/rounds-model';

import { roundResultKey } from './keys';
import {
  announceBatch,
  notifyFromBlockEnv,
  readNotifyFloor,
  type AccountSource,
  type AnnounceItem,
  type NotificationInsert,
  type Roster,
} from './produce';

/// How far below the floor the first scan starts, so rounds already open have their entrants.
export const ROUNDS_LOOKBACK_BLOCKS = 60_000;

const ROUND_EVENTS = [
  getAbiItem({ abi: roundsAbi, name: 'Entered' }),
  getAbiItem({ abi: roundsAbi, name: 'RoundSettled' }),
  getAbiItem({ abi: roundsAbi, name: 'RoundRefunded' }),
] as const;

interface RoundLog extends ScanLog {
  args: Record<string, unknown>;
}

const SIDE_NAME: Record<number, 'up' | 'down'> = { 1: 'up', 2: 'down' };
const REASON_NAME: Record<number, string> = {
  [RefundReason.OneSided]: 'one_sided',
  [RefundReason.Tie]: 'tie',
  [RefundReason.NoPrice]: 'no_price',
};

interface RoundAtFinalized {
  status: number;
  outcome: number;
  refundReason: number;
  upEntrants: number;
  downEntrants: number;
}

const rowsOf = <T>(res: unknown): T[] => {
  const raw = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
  return (Array.isArray(raw) ? raw : []) as T[];
};

interface EntrantRow {
  contractAddress: string;
  roundId: string;
  account: string;
  side: number;
  blockNumber: number;
}

function roundItem(
  db: DbOrTx,
  client: PublicClient,
  ev: {
    contractLower: `0x${string}`;
    id: bigint;
    blockNumber: number;
    eventAt: Date;
    settled: boolean;
    outcome: number;
    reason: number;
    round: RoundAtFinalized;
    batchEntrants: readonly EntrantRow[];
  },
  sleep: (ms: number) => Promise<void>,
): AnnounceItem {
  const idStr = ev.id.toString();
  return {
    blockNumber: ev.blockNumber,
    extraAddresses: [],
    async resolveRoster(accounts) {
      const committed = rowsOf<{ account: string; side: number | string }>(
        await db.execute(sql`SELECT account, side FROM mako_round_entrants WHERE contract_address = ${ev.contractLower} AND round_id = ${idStr}`),
      );
      const ledger: Roster = new Map();
      for (const r of [...committed.map((c) => ({ account: c.account, side: Number(c.side) })), ...ev.batchEntrants]) {
        const name = SIDE_NAME[r.side];
        if (name) ledger.set(r.account.toLowerCase(), new Set([name]));
      }
      const count = (side: string) => [...ledger.values()].filter((s) => s.has(side)).length;
      if (count('up') === ev.round.upEntrants && count('down') === ev.round.downEntrants) return { roster: ledger, fromChain: false };
      const addrs = await accounts();
      const roster: Roster = new Map();
      if (addrs.length > 0) {
        const stakes = (await withRpcRetry(
          () =>
            client.multicall({
              contracts: addrs.map((a) => ({ address: ev.contractLower, abi: roundsAbi, functionName: 'stakeOf' as const, args: [ev.id, a as `0x${string}`] as const })),
              allowFailure: false,
              blockTag: 'finalized',
            }),
          sleep,
        )) as unknown as { side: number; amount: bigint }[];
        addrs.forEach((a, i) => {
          const name = SIDE_NAME[Number(stakes[i].side)];
          if (name && stakes[i].amount > 0n) roster.set(a, new Set([name]));
        });
      }
      return { roster, fromChain: true };
    },
    buildRows(roster, usersOf) {
      const rows: NotificationInsert[] = [];
      const base = { eventAt: ev.eventAt, blockNumber: ev.blockNumber, kind: 'claim' as const, dedupeKey: roundResultKey(ev.contractLower, idStr) };
      const seen = new Set<string>();
      const won = ev.settled ? SIDE_NAME[ev.outcome] : null;
      for (const [addr, sides] of roster) {
        for (const userId of usersOf(addr)) {
          if (seen.has(userId)) continue;
          seen.add(userId);
          const side = [...sides][0];
          if (!ev.settled) {
            rows.push({ ...base, userId, data: { t: 'round', id: idStr, outcome: 'refund', why: 'refund', reason: REASON_NAME[ev.reason] ?? 'one_sided' } });
          } else if (side === won) {
            rows.push({ ...base, userId, data: { t: 'round', id: idStr, outcome: won, why: 'won' } });
          } else {
            rows.push({ ...base, userId, kind: 'result', data: { t: 'round', id: idStr, outcome: won, side } });
          }
        }
      }
      return rows;
    },
  };
}

function roundsBatchWriter() {
  return async (ctx: BatchContext<RoundLog>): Promise<BatchWriteResult> => {
    const { db, chainId, contractLower } = ctx;
    const entrants: EntrantRow[] = ctx.logs
      .filter((l) => l.eventName === 'Entered')
      .map((l) => ({
        contractAddress: contractLower,
        roundId: (l.args.roundId as bigint).toString(),
        account: normalizeAddressLower(l.args.entrant as `0x${string}`),
        side: Number(l.args.side),
        blockNumber: bigintToNumber(l.blockNumber!),
      }));
    // A top-up is a second Entered from the same address on the same side: one entrant row.
    const writeRows = async (tx: DbOrTx) => {
      if (entrants.length === 0) return 0;
      const values = sql.join(
        entrants.map((e) => sql`(${e.contractAddress}, ${e.roundId}, ${e.account}, ${e.side}, ${e.blockNumber})`),
        sql`, `,
      );
      return rowsOf(
        await tx.execute(sql`
          INSERT INTO mako_round_entrants (contract_address, round_id, account, side, block_number)
          VALUES ${values}
          ON CONFLICT (contract_address, round_id, account) DO NOTHING
          RETURNING 1 AS ok`),
      ).length;
    };

    let candidates: RoundLog[] = [];
    if (ctx.notify !== null) {
      const nt0 = (await readNotifyFloor(db, chainId, contractLower, null)).floor ?? ctx.notify.seed;
      if (nt0 !== null) {
        candidates = ctx.logs.filter((l) => l.eventName !== 'Entered' && bigintToNumber(l.blockNumber!) > nt0);
      }
    }
    if (candidates.length === 0) {
      let inserted = 0;
      await (db as DbOrTx & { transaction: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> }).transaction(async (tx) => {
        inserted = await writeRows(tx);
        await ctx.advanceCursor(tx);
      });
      return { eventsInserted: inserted, rosterFromChain: 0, notifiedThrough: null };
    }

    const timestamps = await prefetchBlockTimestamps(ctx.publicClient, candidates, ctx.sleep);
    const ids = [...new Set(candidates.map((l) => l.args.roundId as bigint))];
    const rounds = (await withRpcRetry(
      () =>
        ctx.publicClient.multicall({
          contracts: ids.map((id) => ({ address: contractLower, abi: roundsAbi, functionName: 'roundOf' as const, args: [id] as const })),
          allowFailure: false,
          blockTag: 'finalized',
        }),
      ctx.sleep,
    )) as unknown as RoundAtFinalized[];
    const byId = new Map(ids.map((id, i) => [id, rounds[i]]));
    const items = candidates.map((l) => {
      const id = l.args.roundId as bigint;
      const r = byId.get(id)!;
      const settled = l.eventName === 'RoundSettled';
      const outcome = settled ? Number(l.args.outcome) : RoundOutcome.None;
      const reason = settled ? RefundReason.None : Number(l.args.reason);
      const ok = settled
        ? Number(r.status) === RoundStatus.Settled && Number(r.outcome) === outcome && (outcome === RoundOutcome.Up || outcome === RoundOutcome.Down)
        : Number(r.status) === RoundStatus.Refunded && Number(r.refundReason) === reason;
      if (!ok) throw new Error(`round ${id.toString()}: the finalized re-read does not confirm ${l.eventName}`);
      return roundItem(
        db,
        ctx.publicClient,
        {
          contractLower,
          id,
          blockNumber: bigintToNumber(l.blockNumber!),
          eventAt: timestamps.get(l.blockHash as string)!,
          settled,
          outcome,
          reason,
          round: { ...r, upEntrants: Number(r.upEntrants), downEntrants: Number(r.downEntrants) },
          batchEntrants: entrants.filter((e) => e.roundId === id.toString()),
        },
        ctx.sleep,
      );
    });
    const res = await announceBatch({
      db,
      chainId,
      contractLower,
      batchEnd: ctx.batchEnd,
      seedNotifiedThrough: ctx.notify!.seed,
      items,
      writeRows,
      advanceCursor: ctx.advanceCursor,
      accounts: ctx.accounts,
      hardStopAt: ctx.hardStopAt,
      now: ctx.now,
    });
    return { eventsInserted: res.inserted, rosterFromChain: res.rosterFromChain, notifiedThrough: res.notifiedThrough };
  };
}

export interface RunRoundsScanArgs {
  db: DbOrTx;
  publicClient: PublicClient;
  /// The MakoRoundsV1 address (ROUNDS_ADDRESS in production).
  contractAddress: `0x${string}`;
  chainId?: number;
  chunkSize?: number;
  confirmations?: number;
  staleLockMs?: number;
  timeBudgetMs?: number;
  notifyFromBlock?: number | null;
  hardStopAt?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  accounts?: AccountSource;
}

export async function runRoundsScanOnce(args: RunRoundsScanArgs): Promise<LeaderboardContractScanResult> {
  const contractLower = normalizeAddressLower(args.contractAddress);
  const { publicClient } = args;
  return scanContract<RoundLog>({
    db: args.db,
    publicClient,
    chainId: args.chainId ?? MONAD_TESTNET_ID,
    contractLower,
    floorFor: (F) => (F === null ? null : Math.max(0, F + 1 - ROUNDS_LOOKBACK_BLOCKS)),
    notifyFromBlock: args.notifyFromBlock === undefined ? notifyFromBlockEnv() : args.notifyFromBlock,
    fetchLogs: async (from, to) =>
      (await publicClient.getLogs({
        address: contractLower,
        events: ROUND_EVENTS,
        fromBlock: numberToBigInt(from),
        toBlock: numberToBigInt(to),
      })) as unknown as RoundLog[],
    writeBatch: roundsBatchWriter(),
    chunkSize: args.chunkSize ?? 100,
    confirmations: args.confirmations ?? LEADERBOARD_CONFIRMATIONS,
    staleLockMs: args.staleLockMs ?? LEADERBOARD_STALE_LOCK_MS,
    deadline: args.timeBudgetMs === undefined ? Infinity : (args.now ?? Date.now)() + args.timeBudgetMs,
    hardStopAt: args.hardStopAt,
    sleep: args.sleep,
    now: args.now,
    accounts: args.accounts,
  });
}
