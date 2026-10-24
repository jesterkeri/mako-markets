import 'server-only';

import { and, eq } from 'drizzle-orm';
import { unstable_cache } from 'next/cache';
import { cache } from 'react';
import { decodeEventLog, getAddress, TransactionReceiptNotFoundError, type Hex } from 'viem';

import { db } from '@/db/client';
import { makoMarketEvents } from '@/db/schema';
import { reserveAvatarFetch, reserveAvatarVisitor, reserveCardLoad, reserveCardLookup, reserveCardRender, reserveKnownCardLoad } from '@/lib/avatar-budget';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { initialOf } from '@/lib/leaderboard/board-view';
import { resolveStoredIdentities } from '@/lib/leaderboard/identity';
import { isRegistered } from '@/lib/leaderboard/profile';
import { getMakoLabels } from '@/lib/mako-labels-server';
import { CARD_STATES, placedCard, pnlCard, type CardState, type ShareCard } from '@/lib/pnl-card';
import type { CardWho } from '@/lib/pnl-card-image';
import { poolIdFrom, readPoolForShare, shareClient } from '@/lib/pool-share';
import { formatAddress } from '@/lib/user-display';

// One bet's share card (/pools/<id>/pnl/<tx>/<log>/<state>): public by URL, because Share to X can only post a link
// and the bet is public on chain. The bet is identified by its BetPlaced log, verified on chain, never by anything the
// URL claims. Checks run cheapest first, so a made-up URL never reaches the chain unmetered, nor the database:
//   1. format (canonical lower-case hash, small log index, pool id, a known state),
//   2. the per-visitor limit /api/avatar uses (by IP hash), in Upstash, failing closed,
//   3. the bet ledger first (Codex SHARE_CARDS R2 F1, owner 2026-10-24), behind its own site-wide lookup budget (Codex
//      SHARE_CARDS R3 F1, owner 2026-10-24: under a flood of made-up links a card nobody opened yet is refused for a few
//      seconds, while a result card whose facts are kept on the server makes no lookup at all): a bet the leaderboard indexer recorded (16
//      blocks deep) gives the bettor and the bet time with no RPC call, and only the pool read touches the chain, from
//      the known-bet budget. A bet not in the ledger yet (fresh, or made up) is read from its receipt: its log at that
//      index, emitted by the live V4 contract, decoded as BetPlaced for this pool, from the small unknown-bet budget.
//      Each budget (avatar-budget.ts) is reserved just before its RPC calls and fails closed,
//   4. the pool must be in the link's state. "placed": not settled yet (read at the latest block). "result": settled
//      YES or NO in the last finalized block, so the result's figures are final (refunded: no card). Those final facts
//      (bettor and pool) are kept on the server for good (finalFacts), so a result card's later loads read no chain,
//   5. database: only a Mako Market account's bet has a card. These account reads have their own site-wide budget
//      (reserveCardRender), so one real card flooded from many visitors cannot load the shared database either.
//
// Identity: the card shows only what the account's public profile (/u/<address>) already shows next to that address,
// its name and photo, from the same records: isRegistered is the /u gate, and resolveStoredIdentities is what the
// profile's resolveLabels reads (the stored photo URL stays on the server; the card embeds the image).

const TX = /^0x[0-9a-f]{64}$/;
// Canonical forms only (no leading zeros), so one bet has exactly one URL and one cache entry (the image route also
// refuses any query string).
const LOG = /^(0|[1-9]\d{0,4})$/;

export type CardBettor = { address: `0x${string}`; isYes: boolean; amount: bigint; block: bigint };

export type LoadedCard =
  | { ok: true; state: CardState; card: ShareCard; bettor: CardBettor; poolId: bigint; displayName: string | null; storedPhoto: string | null }
  // unavailable: the chain could not be read just now (429, timeout); like refused, it says nothing about the card.
  // not_yet: a result link for a pool not settled in a finalized block yet, or a link whose bet is neither in the
  // ledger nor in a receipt the server's RPC node has (fresh, or made up). settled: a bet placed link for a pool that reads as settled at the latest block
  // (the page sends it on to the result); not final, a reorg can undo it.
  | { ok: false; reason: 'not_found' | 'not_yet' | 'settled' | 'refused' | 'unavailable' };

/// The BetPlaced log at `logIndex` of `tx`, if it is a bet on `poolId` emitted by the live contract; null when the
/// receipt says it is not; 'no_receipt' when the node has no receipt for `tx` (made up, or not seen by this node yet);
/// 'unavailable' when the chain could not be asked.
export async function readBetLog(poolId: bigint, tx: Hex, logIndex: number): Promise<CardBettor | null | 'no_receipt' | 'unavailable'> {
  let receipt;
  try {
    receipt = await shareClient().getTransactionReceipt({ hash: tx });
  } catch (e) {
    return e instanceof TransactionReceiptNotFoundError ? 'no_receipt' : 'unavailable';
  }
  if (receipt.status !== 'success') return null;
  const log = receipt.logs.find((l) => l.logIndex === logIndex);
  if (!log || log.address.toLowerCase() !== MAKO_ADDRESS.toLowerCase()) return null;
  try {
    const ev = decodeEventLog({ abi: makoAbi, data: log.data, topics: log.topics, strict: true });
    if (ev.eventName !== 'BetPlaced' || ev.args.id !== poolId) return null;
    return { address: ev.args.user.toLowerCase() as `0x${string}`, isYes: ev.args.isYes, amount: ev.args.amount, block: receipt.blockNumber };
  } catch {
    return null;
  }
}

const isState = (s: string): s is CardState => (CARD_STATES as readonly string[]).includes(s);

type Miss = Extract<LoadedCard, { ok: false }>['reason'];
type Facts = { bettor: CardBettor; market: MarketWithId; betAt: bigint };

/// The bet as the leaderboard ledger has it, read the way src/lib/leaderboard reads it; null when it is not there, or
/// the database could not answer (then the receipt path, behind its small budget, decides).
async function ledgerBet(tx: string, logIndex: number) {
  try {
    const e = makoMarketEvents;
    const [row] = await db
      .select({ marketId: e.marketId, actor: e.actor, isYes: e.isYes, amount: e.amount, block: e.blockNumber, at: e.blockTimestamp })
      .from(e)
      .where(and(eq(e.chainId, MONAD_TESTNET_ID), eq(e.contractAddress, MAKO_ADDRESS.toLowerCase()), eq(e.kind, 'bet'), eq(e.txHash, tx), eq(e.logIndex, logIndex)))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/// The bet's block time, for the bet placed card's date; null when the chain could not be read.
async function blockTime(block: bigint): Promise<bigint | null> {
  try {
    return (await shareClient().getBlock({ blockNumber: block })).timestamp;
  } catch {
    return null;
  }
}

/// The bet and its pool from the chain (steps 3 and 4 above), or why there is none. not_found here is final: a receipt
/// with no matching BetPlaced log, or a ledger row for another pool.
async function readFacts(poolId: bigint, tx: Hex, logIndex: number, state: CardState): Promise<Facts | Miss> {
  if (!(await reserveCardLookup())) return 'refused';
  const row = await ledgerBet(tx, logIndex);
  const tag = state === 'result' ? 'finalized' : 'latest';
  let bettor: CardBettor, market: MarketWithId | null;
  if (row) {
    if (row.marketId !== poolId.toString()) return 'not_found';
    if (!(await reserveKnownCardLoad())) return 'refused';
    bettor = { address: row.actor as `0x${string}`, isYes: row.isYes === true, amount: BigInt(row.amount), block: BigInt(row.block) };
    market = await readPoolForShare(poolId, tag);
  } else {
    if (!(await reserveCardLoad())) return 'refused';
    const [b, m] = await Promise.all([readBetLog(poolId, tx, logIndex), readPoolForShare(poolId, tag)]);
    if (b === 'unavailable') return 'unavailable';
    // The bet confirmation offers Share as soon as the wallet's RPC has the receipt, and the server's node can be a
    // block behind it. A result link too (Codex SHARE_CARDS R2 F3): the receipt and the finalized pool can come from
    // different RPC backends, so one's answer proves nothing about the other's. No receipt is not_yet, never cached.
    if (b === 'no_receipt') return 'not_yet';
    if (!b) return 'not_found';
    bettor = b;
    market = m;
  }
  // The bet proves the pool exists, so no pool here means the read failed, not a missing pool.
  if (!market) return 'unavailable';
  if (state === 'placed' && market.resolved) return 'settled';
  if (state === 'result' && !market.resolved) return 'not_yet';
  // The bet and the pool are separate reads, possibly from different RPC nodes: a pool read a block behind the bet has
  // a pot without it, and its estimate would be made up. Unreadable for now, not a card that is wrong.
  if (state === 'placed' && (bettor.isYes ? market.totalYes : market.totalNo) < bettor.amount) return 'unavailable';
  const betAt = row ? BigInt(Math.floor(row.at.getTime() / 1000)) : state === 'placed' ? await blockTime(bettor.block) : 0n;
  if (betAt === null) return 'unavailable';
  return { bettor, market, betAt };
}

class NotFinal extends Error {
  constructor(readonly reason: Miss) {
    super(reason);
  }
}

const BIG = new Set(['id', 'createdAt', 'closeTime', 'bettingCloseTime', 'totalYes', 'totalNo', 'amount', 'block', 'betAt']);

/// A result card's final facts, kept in Next's data cache (unstable_cache: this app does not enable Cache Components,
/// which 'use cache' needs) with no expiry, by contract and (pool, tx, log): a pool settled YES or NO in a finalized
/// block, and the bet before it, cannot change. Every other answer is thrown, so it is never kept. Only chain facts
/// are kept: name, photo and labels are read fresh on every render. The data cache stores JSON, so bigints travel as
/// strings.
const finalFacts = unstable_cache(
  async (pool: string, tx: string, logIndex: number): Promise<string> => {
    const f = await readFacts(BigInt(pool), tx as Hex, logIndex, 'result');
    if (typeof f === 'string') throw new NotFinal(f);
    if (f.market.outcome !== Outcome.YES && f.market.outcome !== Outcome.NO) throw new NotFinal('not_found');
    return JSON.stringify(f, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  },
  ['pnl-card-final-v1', String(MONAD_TESTNET_ID), MAKO_ADDRESS.toLowerCase()],
  { revalidate: false },
);

async function resultFacts(poolId: bigint, tx: string, logIndex: number): Promise<Facts | Miss> {
  try {
    return JSON.parse(await finalFacts(poolId.toString(), tx, logIndex), (k, v) => (BIG.has(k) && typeof v === 'string' ? BigInt(v) : v));
  } catch (e) {
    if (e instanceof NotFinal) return e.reason;
    throw e;
  }
}

/// Everything the card page and its image need, or why there is none. cache(): the page and its metadata share one
/// load per request.
export const loadCard = cache(async (idRaw: string, txRaw: string, logRaw: string, stateRaw: string, ip: string): Promise<LoadedCard> => {
  const poolId = poolIdFrom(idRaw);
  if (poolId === null || idRaw !== poolId.toString() || !TX.test(txRaw) || !LOG.test(logRaw) || !isState(stateRaw)) return { ok: false, reason: 'not_found' };
  const state = stateRaw;
  // Over this visitor's limit, or the store down: refused before anything else.
  if (!(await reserveAvatarVisitor(ip))) return { ok: false, reason: 'refused' };
  const facts = state === 'result' ? await resultFacts(poolId, txRaw, Number(logRaw)) : await readFacts(poolId, txRaw as Hex, Number(logRaw), state);
  if (typeof facts === 'string') return { ok: false, reason: facts };
  const { bettor, market, betAt } = facts;
  const nowSec = Math.floor(Date.now() / 1000);
  const draw = (labels: { yes: string; no: string }): ShareCard | null =>
    state === 'placed' ? placedCard(market, bettor, labels, betAt, nowSec) : pnlCard(market, bettor, labels);
  // Labels only change the side's name, so the card check runs on the default ones first: no card, no database.
  if (!draw({ yes: 'YES', no: 'NO' })) return { ok: false, reason: 'not_found' };
  // A real card's account reads (Codex SHARE_CARDS R3 F1): their own site-wide budget, which made-up links never reach.
  if (!(await reserveCardRender())) return { ok: false, reason: 'refused' };
  if (!(await isRegistered(bettor.address))) return { ok: false, reason: 'not_found' };
  const [identity, labels] = await Promise.all([
    resolveStoredIdentities(db, [bettor.address], MONAD_TESTNET_ID),
    market.mType === MarketType.MAKO ? getMakoLabels(db, poolId.toString()) : Promise.resolve(null),
  ]);
  const card = draw(labels ? { yes: labels.label1, no: labels.label2 } : { yes: 'YES', no: 'NO' })!;
  const id = identity.get(bettor.address);
  return { ok: true, state, card, bettor, poolId, displayName: id?.displayName ?? null, storedPhoto: id?.avatarUrl ?? null };
});

const PHOTO_TYPES = new Set(['image/png', 'image/jpeg']);

/// The name, letter and photo for the card. The photo is fetched only within the site-wide avatar budget and only as
/// PNG or JPEG (what the renderer reads); anything else, or a failure, is the letter avatar. `complete` is false when
/// the account has a photo the card could not draw: that card must not be cached as the account's card.
export async function cardWho(c: Extract<LoadedCard, { ok: true }>): Promise<{ who: CardWho; complete: boolean }> {
  const name = c.displayName?.trim() || null;
  const who: CardWho = { handle: name ? `@${name}` : formatAddress(getAddress(c.bettor.address)), initial: initialOf(name, c.bettor.address), photo: null };
  if (!c.storedPhoto) return { who, complete: true };
  if (!(await reserveAvatarFetch())) return { who, complete: false };
  try {
    const res = await fetch(c.storedPhoto, { signal: AbortSignal.timeout(5_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !PHOTO_TYPES.has(type)) return { who, complete: false };
    return { who: { ...who, photo: `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` }, complete: true };
  } catch {
    return { who, complete: false };
  }
}
