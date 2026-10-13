// Which rounds Me reads for one account (Codex ME_ROUNDS R1, MAJOR): not every round ever scheduled, which grew without
// bound (about 12 rounds a day, four reads each, every 10 s), but the rounds the indexer knows the account is in, plus
// every round the indexer cannot vouch for yet. Pure and browser-safe: the route (src/app/api/me/rounds/route.ts)
// answers the wire shape below, use-me-rounds.ts parses it and plans the reads here.
//
// Everything below holds only if the indexer indexes THIS Rounds contract (NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS on Monad
// testnet). Nothing in the answer can say so by itself: ENVIO_ROUNDS_GRAPHQL_URL may serve a preview build, a redeploy or
// another deployment, and a repo config test cannot prove what the hosted endpoint serves (Codex ME_ROUNDS R2, MAJOR).
// So the answer is BOUND to the chain at runtime, every poll, before any of it is trusted:
//   0. `head` is the indexer's own round `indexedThrough` (openTime, startTime, creator, as RoundScheduled set them).
//      The browser always reads roundOf(head.id) on chain and trusts the answer only if all three are equal
//      (headMatchesChain). openTime is the block time of the schedule() call and the three never change after it, so
//      another deployment's round with the same id carrying the same fingerprint would have to be scheduled by the same
//      creator in a block with the same timestamp, for the same start. A head the chain does not have (any
//      `indexedThrough` above roundCount) is refused before reading: an indexer ahead of the chain is not this
//      contract's, or not yet comparable; either way the poll is unavailable and the next one reads both again.
// Given that binding, why nothing the account can claim is missed (the route reads the indexer in this order, each
// read after the last):
//   1. `indexedThrough`: the highest round id the indexer has seen scheduled. Round ids are 1, 2, 3, ... and the
//      indexer processes events in block order, so it has seen every round up to it. Every id above it is read on
//      chain whatever the indexer says.
//   2. Every round the indexer still has as Active (scheduled, open, locked or waiting to settle). Its entries may
//      still be arriving, so it is read on chain. The contract allows at most MAX_ACTIVE_ROUNDS active rounds, and the
//      indexer's view is the chain at an earlier block, so this list is short.
//   3. Every round the account has a RoundEntry in, and every round it created. A round at or below `indexedThrough`
//      that the indexer no longer has as Active was settled or refunded in a block the indexer has processed, and
//      every entry comes before that block, so its entries are all indexed by step 3. Its creator was indexed with it.
// So a round where the account has a stake or a creator fee is in one of the three sets. The newest
// ME_ROUNDS_RECENT ids are read as well, whatever the answer says, so a fresh round never waits on the indexer.
// An older answer stays complete: its `indexedThrough` is lower, which only widens the ids read on chain, and its head
// is still a round of this contract with the same fingerprint.

/// MakoRoundsV1.MAX_ACTIVE_ROUNDS (mako-contracts/src/MakoRoundsV1.sol).
export const MAX_ACTIVE_ROUNDS = 10;
/// The newest round ids always read on chain, at least every round that can be active at once.
export const ME_ROUNDS_RECENT = 12;
/// More rounds than this past the indexer's last scheduled round means the indexer is stuck or wrong: Me says the
/// rounds part is unavailable instead of reading an unbounded range (12 rounds a day: about ten days).
export const ME_ROUNDS_MAX_UNINDEXED = 120;

/// The indexer's newest round as RoundScheduled recorded it. Times are decimal Unix seconds (uint64), the creator a
/// lower-case 0x address.
export type MeRoundsHeadWire = { id: string; openTime: string; startTime: string; creator: string };
/// GET /api/me/rounds?account=0x... answers 200 with this. Ids are decimal strings, ascending, without duplicates.
/// `head` is null exactly when `indexedThrough` is "0", and otherwise is round `indexedThrough`.
export type MeRoundsDiscoveryWire = { roundIds: string[]; indexedThrough: string; head: MeRoundsHeadWire | null };
export type MeRoundsHead = { id: bigint; openTime: bigint; startTime: bigint; creator: string };
export type MeRoundsDiscovery = { roundIds: bigint[]; indexedThrough: bigint; head: MeRoundsHead | null };

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
/// A uint64 in decimal, as MakoRoundsV1 stores openTime and startTime.
const UINT64 = /^(0|[1-9][0-9]{0,19})$/;
const UINT64_MAX = (1n << 64n) - 1n;
const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;

/// A uint64 decimal string as bigint, or null.
export function parseUint64(v: unknown): bigint | null {
  if (typeof v !== 'string' || !UINT64.test(v)) return null;
  const n = BigInt(v);
  return n <= UINT64_MAX ? n : null;
}

function parseHead(v: unknown, indexedThrough: string): MeRoundsHead | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const { id, openTime, startTime, creator } = v as Record<string, unknown>;
  if (id !== indexedThrough) return undefined;
  const open = parseUint64(openTime);
  const start = parseUint64(startTime);
  if (open === null || start === null || typeof creator !== 'string' || !LOWER_ADDRESS.test(creator)) return undefined;
  return { id: BigInt(id), openTime: open, startTime: start, creator };
}

/// The route's answer, or null when it is not exactly the wire shape (a null is a failed read, never "no rounds").
export function parseMeRoundsDiscovery(body: unknown): MeRoundsDiscovery | null {
  if (!body || typeof body !== 'object') return null;
  const { roundIds, indexedThrough, head } = body as Record<string, unknown>;
  if (!Array.isArray(roundIds) || typeof indexedThrough !== 'string' || !DECIMAL.test(indexedThrough)) return null;
  // Null exactly when the indexer has no rounds; otherwise round `indexedThrough`'s fingerprint, strictly.
  const parsedHead = parseHead(head, indexedThrough);
  if (parsedHead === undefined || (parsedHead === null) !== (indexedThrough === '0')) return null;
  const ids: bigint[] = [];
  for (const raw of roundIds) {
    if (typeof raw !== 'string' || !DECIMAL.test(raw) || raw === '0') return null;
    const id = BigInt(raw);
    if (ids.length > 0 && id <= ids[ids.length - 1]) return null;
    ids.push(id);
  }
  return { roundIds: ids, indexedThrough: BigInt(indexedThrough), head: parsedHead };
}

/// roundOf(head.id) on chain, the three fields compared.
export type RoundFingerprint = { creator: string; openTime: bigint; startTime: bigint };

/// True only if the indexer's head round is this contract's round of the same id: the same openTime, startTime and
/// creator (address letter case ignored). Anything else means the answer describes another contract: unavailable.
export function headMatchesChain(head: MeRoundsHead, chain: RoundFingerprint): boolean {
  return (
    BigInt(chain.openTime) === head.openTime &&
    BigInt(chain.startTime) === head.startTime &&
    typeof chain.creator === 'string' &&
    chain.creator.toLowerCase() === head.creator.toLowerCase()
  );
}

export type MeRoundsPlan = { ok: true; ids: bigint[] } | { ok: false; reason: 'indexer_behind' | 'indexer_ahead' };

/// The round ids to read on chain this poll, ascending, without duplicates: the discovered ids that exist (`<= count`),
/// the indexer's head round (always, for the fingerprint check), and every id from the lower of (the indexer's last
/// round + 1) and (count - ME_ROUNDS_RECENT + 1) up to `count`. The number of ids is at most
/// discovered + max(ME_ROUNDS_RECENT, count - indexedThrough) + 1, however many rounds exist. Any indexer head above
/// `count` is refused (Codex ME_ROUNDS R2): no slack, since a head the chain lacks cannot be checked.
export function planMeRoundReads(count: bigint, d: MeRoundsDiscovery): MeRoundsPlan {
  const onChain = count > 0n ? count : 0n;
  if (d.indexedThrough > onChain) return { ok: false, reason: 'indexer_ahead' };
  if (onChain === 0n) return { ok: true, ids: [] };
  if (onChain - d.indexedThrough > BigInt(ME_ROUNDS_MAX_UNINDEXED)) return { ok: false, reason: 'indexer_behind' };
  const recentFrom = onChain - BigInt(ME_ROUNDS_RECENT) + 1n;
  const unindexedFrom = d.indexedThrough + 1n;
  let from = recentFrom < unindexedFrom ? recentFrom : unindexedFrom;
  if (from < 1n) from = 1n;
  const below = new Set(d.roundIds.filter((id) => id >= 1n && id < from));
  if (d.head && d.head.id >= 1n && d.head.id < from) below.add(d.head.id);
  const out = [...below].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let id = from; id <= onChain; id++) out.push(id);
  return { ok: true, ids: out };
}
