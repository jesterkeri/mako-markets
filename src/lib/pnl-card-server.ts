import 'server-only';

import { cache } from 'react';
import { decodeEventLog, getAddress, TransactionReceiptNotFoundError, type Hex } from 'viem';

import { db } from '@/db/client';
import { reserveAvatarFetch, reserveAvatarVisitor, reserveCardLoad } from '@/lib/avatar-budget';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS, makoAbi, MarketType } from '@/lib/contract';
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
//   2. limits, before any RPC call (Codex SHARE_CARDS R1 F1): the per-visitor limit /api/avatar uses (by IP hash), then
//      the site-wide card load budget (avatar-budget.ts reserveCardLoad), both in Upstash and both failing closed,
//   3. chain: the receipt's log at that index, emitted by the live V4 contract, decoded as BetPlaced for this pool;
//      then the pool must be in the link's state. "placed": not settled yet (read at the latest block). "result":
//      settled YES or NO in the last finalized block, so the result's figures are final (refunded: no card),
//   4. database: only a Mako Market account's bet has a card.
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
  // not_yet: a result link for a pool not settled in a finalized block yet. settled: a bet placed link for a pool that
  // reads as settled at the latest block (the page sends it on to the result); not final, a reorg can undo it.
  | { ok: false; reason: 'not_found' | 'not_yet' | 'settled' | 'refused' | 'unavailable' };

/// The BetPlaced log at `logIndex` of `tx`, if it is a bet on `poolId` emitted by the live contract; null when the
/// chain says it is not; 'unavailable' when the chain could not be asked (only a missing receipt means "no such bet").
export async function readBetLog(poolId: bigint, tx: Hex, logIndex: number): Promise<CardBettor | null | 'unavailable'> {
  let receipt;
  try {
    receipt = await shareClient().getTransactionReceipt({ hash: tx });
  } catch (e) {
    return e instanceof TransactionReceiptNotFoundError ? null : 'unavailable';
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

/// The bet's block time, for the bet placed card's date; null when the chain could not be read.
async function blockTime(block: bigint): Promise<bigint | null> {
  try {
    return (await shareClient().getBlock({ blockNumber: block })).timestamp;
  } catch {
    return null;
  }
}

/// Everything the card page and its image need, or why there is none. cache(): the page and its metadata share one
/// load per request.
export const loadCard = cache(async (idRaw: string, txRaw: string, logRaw: string, stateRaw: string, ip: string): Promise<LoadedCard> => {
  const poolId = poolIdFrom(idRaw);
  if (poolId === null || idRaw !== poolId.toString() || !TX.test(txRaw) || !LOG.test(logRaw) || !isState(stateRaw)) return { ok: false, reason: 'not_found' };
  const state = stateRaw;
  // Over this visitor's limit or the site-wide budget, or the store down: refused before the first RPC call.
  if (!(await reserveAvatarVisitor(ip)) || !(await reserveCardLoad())) return { ok: false, reason: 'refused' };
  // A pool settled in a finalized block was settled after every bet on it (bets stop at betting close, before
  // close), so the bet's receipt is final too.
  const [bettor, market] = await Promise.all([readBetLog(poolId, txRaw as Hex, Number(logRaw)), readPoolForShare(poolId, state === 'result' ? 'finalized' : 'latest')]);
  if (bettor === 'unavailable') return { ok: false, reason: 'unavailable' };
  if (!bettor) return { ok: false, reason: 'not_found' };
  // The bet's own log proves the pool exists, so no pool here means the read failed, not a missing pool.
  if (!market) return { ok: false, reason: 'unavailable' };
  if (state === 'placed' && market.resolved) return { ok: false, reason: 'settled' };
  if (state === 'result' && !market.resolved) return { ok: false, reason: 'not_yet' };
  // The receipt and the pool are separate reads, possibly from different RPC nodes: a pool read a block behind the
  // bet has a pot without it, and its estimate would be made up. Unreadable for now, not a card that is wrong.
  if (state === 'placed' && (bettor.isYes ? market.totalYes : market.totalNo) < bettor.amount) return { ok: false, reason: 'unavailable' };
  const betAt = state === 'placed' ? await blockTime(bettor.block) : 0n;
  if (betAt === null) return { ok: false, reason: 'unavailable' };
  const nowSec = Math.floor(Date.now() / 1000);
  const draw = (labels: { yes: string; no: string }): ShareCard | null =>
    state === 'placed' ? placedCard(market, bettor, labels, betAt, nowSec) : pnlCard(market, bettor, labels);
  // Labels only change the side's name, so the card check runs on the default ones first: no card, no database.
  if (!draw({ yes: 'YES', no: 'NO' })) return { ok: false, reason: 'not_found' };
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
