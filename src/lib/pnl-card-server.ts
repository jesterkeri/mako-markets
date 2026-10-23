import 'server-only';

import { cache } from 'react';
import { decodeEventLog, TransactionReceiptNotFoundError, type Hex } from 'viem';

import { db } from '@/db/client';
import { reserveAvatarFetch, reserveAvatarVisitor } from '@/lib/avatar-budget';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS, makoAbi, MarketType } from '@/lib/contract';
import { initialOf } from '@/lib/leaderboard/board-view';
import { registeredAddresses, resolveStoredIdentities } from '@/lib/leaderboard/identity';
import { getMakoLabels } from '@/lib/mako-labels-server';
import { pnlCard, type PnlCard } from '@/lib/pnl-card';
import type { CardWho } from '@/lib/pnl-card-image';
import { poolIdFrom, readPoolForShare, shareClient } from '@/lib/pool-share';
import { formatAddress } from '@/lib/user-display';

// One bet's share card (/pools/<id>/pnl/<tx>/<log>): public by URL, because Share to X can only post a link and the
// bet is public on chain. The bet is identified by its BetPlaced log, verified on chain, never by anything the URL
// claims. Checks run cheapest first, so a made-up URL never reaches the database:
//   1. format (canonical lower-case hash, small log index, pool id),
//   2. chain: the receipt's log at that index, emitted by the live V4 contract, decoded as BetPlaced for this pool;
//      the pool settled YES or NO (refunded or unresolved: no card),
//   3. the per-visitor limit /api/avatar uses (by IP hash, in Upstash),
//   4. database: only a Mako Market account's bet has a card (the /u rule), then its name and photo.

const TX = /^0x[0-9a-f]{64}$/;
// Canonical forms only (no leading zeros), so one bet has exactly one URL and one cache entry.
const LOG = /^(0|[1-9]\d{0,4})$/;

export type CardBettor = { address: `0x${string}`; isYes: boolean; amount: bigint };

export type LoadedCard =
  | { ok: true; card: PnlCard; bettor: CardBettor; poolId: bigint; displayName: string | null; storedPhoto: string | null }
  // unavailable: the chain could not be read just now (429, timeout); like refused, it says nothing about the card.
  | { ok: false; reason: 'not_found' | 'refused' | 'unavailable' };

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
    return { address: ev.args.user.toLowerCase() as `0x${string}`, isYes: ev.args.isYes, amount: ev.args.amount };
  } catch {
    return null;
  }
}

/// Everything the card page and its image need, or why there is none. cache(): the page and its metadata share one
/// load per request.
export const loadCard = cache(async (idRaw: string, txRaw: string, logRaw: string, ip: string): Promise<LoadedCard> => {
  const poolId = poolIdFrom(idRaw);
  if (poolId === null || idRaw !== poolId.toString() || !TX.test(txRaw) || !LOG.test(logRaw)) return { ok: false, reason: 'not_found' };
  const [bettor, market] = await Promise.all([readBetLog(poolId, txRaw as Hex, Number(logRaw)), readPoolForShare(poolId)]);
  if (bettor === 'unavailable') return { ok: false, reason: 'unavailable' };
  if (!bettor) return { ok: false, reason: 'not_found' };
  // The bet's own log proves the pool exists, so no pool here means the read failed, not a missing pool.
  if (!market) return { ok: false, reason: 'unavailable' };
  // Labels only change the side's name, so the result check runs on the default ones first: no card, no database.
  if (!pnlCard(market, bettor, { yes: 'YES', no: 'NO' })) return { ok: false, reason: 'not_found' };
  if (!(await reserveAvatarVisitor(ip))) return { ok: false, reason: 'refused' };
  if (!(await registeredAddresses(db, [bettor.address], MONAD_TESTNET_ID)).has(bettor.address)) return { ok: false, reason: 'not_found' };
  const [identity, labels] = await Promise.all([
    resolveStoredIdentities(db, [bettor.address], MONAD_TESTNET_ID),
    market.mType === MarketType.MAKO ? getMakoLabels(db, poolId.toString()) : Promise.resolve(null),
  ]);
  const card = pnlCard(market, bettor, labels ? { yes: labels.label1, no: labels.label2 } : { yes: 'YES', no: 'NO' })!;
  const id = identity.get(bettor.address);
  return { ok: true, card, bettor, poolId, displayName: id?.displayName ?? null, storedPhoto: id?.avatarUrl ?? null };
});

const PHOTO_TYPES = new Set(['image/png', 'image/jpeg']);

/// The name, letter and photo for the card. The photo is fetched only within the site-wide avatar budget and only as
/// PNG or JPEG (what the renderer reads); anything else, or a failure, is the letter avatar.
export async function cardWho(c: Extract<LoadedCard, { ok: true }>): Promise<CardWho> {
  const name = c.displayName?.trim() || null;
  const who: CardWho = { handle: name ? `@${name}` : formatAddress(c.bettor.address), initial: initialOf(name, c.bettor.address), photo: null };
  if (!c.storedPhoto || !(await reserveAvatarFetch())) return who;
  try {
    const res = await fetch(c.storedPhoto, { signal: AbortSignal.timeout(5_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !PHOTO_TYPES.has(type)) return who;
    return { ...who, photo: `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` };
  } catch {
    return who;
  }
}
