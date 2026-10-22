// ----------------------------------------------------------------------------
// #214 Notifications S1 test harness (NOTIFICATIONS_PLAN r8 §8 S1).
//
// The database: every migration through 0020, in journal order, on pglite (the pattern of
// src/lib/__tests__/adversary-display-name-trigger-bbbfa92.test.ts), so `users`, `user_safes`, their CHECKs, 0017's
// trigger and 0020's account-address version triggers are the real ones. The migrated instance is built once and
// cloned per test.
//
// The chain: a mock PublicClient that answers getBlockNumber, getLogs (only for the blocks it is asked for), getBlock
// and multicall (getMarket, getUserBet, roundOf, stakeOf) from its own state, which stands for 'finalized'. It counts
// what it was asked, so tests can assert that a position read did or did not happen.
// ----------------------------------------------------------------------------

import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PublicClient } from 'viem';

import * as schema from '@/db/schema';
import type { LeaderboardContract } from '@/lib/leaderboard/contracts';

export const CHAIN = 10143;
export const V4: LeaderboardContract = { address: '0x00000000000000000000000000000000000000aa', deployBlock: 100, version: 'v4' };
export const ROUNDS = '0x00000000000000000000000000000000000000cc' as const;

const DIR = resolve('src/db/migrations');

async function buildBase(): Promise<PGlite> {
  const pg = new PGlite();
  const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const e of journal.entries) {
    for (const stmt of readFileSync(join(DIR, `${e.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  return pg;
}

let base: Promise<PGlite> | null = null;

export interface NotifyDb {
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}

export async function createNotifyDb(): Promise<NotifyDb> {
  base ??= buildBase();
  const client = (await (await base).clone()) as PGlite;
  return { client, db: drizzle(client, { schema }), close: () => client.close() };
}

export const noSleep = async () => {};

// ---- Accounts ---------------------------------------------------------------

let n = 0;
const hex40 = (k: number) => `0x${k.toString(16).padStart(40, '0')}`;

/// An email account with a Safe on CHAIN (stored checksummed, as deriveSafeAddress returns it). Returns its id.
export async function emailAccount(t: NotifyDb, safe: string | null): Promise<string> {
  n += 1;
  const r = await t.client.query<{ id: string }>(
    `INSERT INTO users (email, magic_eoa, auth_type) VALUES ($1, $2, 'magic') RETURNING id`,
    [`user${n}-${Math.random().toString(36).slice(2)}@example.com`, hex40(0xe0a0000 + n)],
  );
  const id = r.rows[0].id;
  if (safe) await t.client.query(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, $2, $3)`, [id, CHAIN, safe]);
  return id;
}

/// A wallet account (wallet_address lowercase, as the CHECK requires). Returns its id.
export async function walletAccount(t: NotifyDb, wallet: string): Promise<string> {
  const r = await t.client.query<{ id: string }>(`INSERT INTO users (wallet_address, auth_type) VALUES ($1, 'wallet') RETURNING id`, [wallet.toLowerCase()]);
  return r.rows[0].id;
}

export async function version(t: NotifyDb): Promise<number> {
  return Number((await t.client.query<{ version: string }>(`SELECT version FROM account_address_version`)).rows[0].version);
}

export async function notificationsOf(t: NotifyDb, userId?: string) {
  const r = await t.client.query<{ user_id: string; kind: string; dedupe_key: string; data: Record<string, unknown>; read_at: string | null }>(
    `SELECT user_id, kind, dedupe_key, data, read_at FROM notifications ${userId ? 'WHERE user_id = $1' : ''} ORDER BY dedupe_key, user_id`,
    userId ? [userId] : [],
  );
  return r.rows;
}

export async function notifiedThrough(t: NotifyDb, contract: string): Promise<number | null> {
  const r = await t.client.query<{ nt: string }>(`SELECT notified_through AS nt FROM notify_cursor WHERE contract_address = $1`, [contract.toLowerCase()]);
  return r.rows.length ? Number(r.rows[0].nt) : null;
}

export async function setCursor(t: NotifyDb, contract: string, last: number) {
  await t.client.query(
    `INSERT INTO mako_leaderboard_indexer_state (chain_id, contract_address, last_scanned_block, last_scan_target) VALUES ($1, $2, $3, $3)
     ON CONFLICT (chain_id, contract_address) DO UPDATE SET last_scanned_block = $3`,
    [CHAIN, contract.toLowerCase(), last],
  );
}

export async function cursorOf(t: NotifyDb, contract: string): Promise<number | null> {
  const r = await t.client.query<{ b: string }>(`SELECT last_scanned_block AS b FROM mako_leaderboard_indexer_state WHERE contract_address = $1`, [contract.toLowerCase()]);
  return r.rows.length ? Number(r.rows[0].b) : null;
}

// ---- Chain ------------------------------------------------------------------

export const hex32 = (k: number | bigint) => `0x${BigInt(k).toString(16).padStart(64, '0')}` as `0x${string}`;

export interface ChainLog {
  address: string;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
}

let tx = 0;
const log = (address: string, eventName: string, block: number, args: Record<string, unknown>): ChainLog => {
  tx += 1;
  return { address: address.toLowerCase(), eventName, args, blockNumber: BigInt(block), blockHash: hex32(block), transactionHash: hex32(0x7000000 + tx), logIndex: tx % 50 };
};

export const betLog = (id: number, user: string, isYes: boolean, block: number, amount = 1_000_000n) =>
  log(V4.address, 'BetPlaced', block, { id: BigInt(id), user, isYes, amount });
export const resolvedLog = (id: number, outcome: number, block: number) => log(V4.address, 'MarketResolved', block, { id: BigInt(id), outcome });
export const enteredLog = (round: number, entrant: string, side: 1 | 2, block: number, amount = 1_000_000n) =>
  log(ROUNDS, 'Entered', block, { roundId: BigInt(round), entrant, side, amount, stakeTotal: amount });
export const settledLog = (round: number, outcome: 1 | 2, block: number) => log(ROUNDS, 'RoundSettled', block, { roundId: BigInt(round), outcome });
export const refundedLog = (round: number, reason: number, block: number) => log(ROUNDS, 'RoundRefunded', block, { roundId: BigInt(round), reason });
export const tiedLog = (round: number, block: number) => log(ROUNDS, 'RoundTied', block, { roundId: BigInt(round), anchorPrice: 1n, closePrice: 1n });

export interface Market {
  creator: string;
  totalYes: bigint;
  totalNo: bigint;
  yesBettorCount: number;
  noBettorCount: number;
  outcome: number;
  resolved: boolean;
  creatorFeeBpsSnapshot: number;
  question?: string;
}

export interface RoundState {
  status: number;
  outcome: number;
  refundReason: number;
  upEntrants: number;
  downEntrants: number;
}

export interface ChainState {
  head: number;
  logs: ChainLog[];
  markets: Map<string, Market>;
  /// `${id}:${lowercase address}` -> [yes, no]
  bets: Map<string, [bigint, bigint]>;
  rounds: Map<string, RoundState>;
  /// `${roundId}:${lowercase address}` -> stake
  stakes: Map<string, { side: number; amount: bigint }>;
  /// Fail this many getUserBet / stakeOf multicalls with a rate-limit error.
  failPositionReads: number;
}

export interface MockChain {
  client: PublicClient;
  state: ChainState;
  calls: { getLogs: { address: string; from: number; to: number }[]; positionReads: number; positionAddresses: string[] };
}

export function mockChain(init: Partial<ChainState> & { head: number }): MockChain {
  const state: ChainState = {
    logs: [],
    markets: new Map(),
    bets: new Map(),
    rounds: new Map(),
    stakes: new Map(),
    failPositionReads: 0,
    ...init,
  };
  const calls: MockChain['calls'] = { getLogs: [], positionReads: 0, positionAddresses: [] };
  const client = {
    getBlockNumber: async () => BigInt(state.head),
    getLogs: async (a: { address: string; fromBlock: bigint; toBlock: bigint; events?: readonly { name?: string }[] }) => {
      const from = Number(a.fromBlock);
      const to = Number(a.toBlock);
      calls.getLogs.push({ address: a.address, from, to });
      // Like a real topic filter: only the events asked for.
      const names = a.events ? new Set(a.events.map((e) => e.name)) : null;
      return state.logs
        .filter((l) => l.address === a.address.toLowerCase() && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to)
        .filter((l) => !names || names.has(l.eventName))
        .sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex);
    },
    getBlock: async (a: { blockHash: `0x${string}` }) => ({ timestamp: BigInt(1_790_000_000) + BigInt(a.blockHash) }),
    multicall: async (a: { contracts: { functionName: string; args: unknown[] }[]; blockTag?: string }) => {
      if (a.blockTag !== 'finalized') throw new Error(`mock chain: expected blockTag finalized, got ${a.blockTag}`);
      const fn = a.contracts[0]?.functionName;
      if ((fn === 'getUserBet' || fn === 'stakeOf') && state.failPositionReads > 0) {
        state.failPositionReads -= 1;
        throw Object.assign(new Error('mock RPC: requests limited'), { code: -32011 });
      }
      return a.contracts.map((c) => {
        const id = String(c.args[0]);
        switch (c.functionName) {
          case 'getMarket': {
            const m = state.markets.get(id);
            if (!m) throw new Error(`mock chain: no market ${id}`);
            return { question: m.question ?? 'q', ...m };
          }
          case 'getUserBet': {
            calls.positionReads += 1;
            const who = String(c.args[1]).toLowerCase();
            calls.positionAddresses.push(who);
            const b = state.bets.get(`${id}:${who}`) ?? [0n, 0n];
            return [b[0], b[1], false] as const;
          }
          case 'roundOf': {
            const r = state.rounds.get(id);
            if (!r) throw new Error(`mock chain: no round ${id}`);
            return r;
          }
          case 'stakeOf': {
            calls.positionReads += 1;
            const who = String(c.args[1]).toLowerCase();
            calls.positionAddresses.push(who);
            return state.stakes.get(`${id}:${who}`) ?? { side: 0, amount: 0n };
          }
          default:
            throw new Error(`mock chain: unexpected ${c.functionName}`);
        }
      });
    },
  };
  return { client: client as unknown as PublicClient, state, calls };
}
