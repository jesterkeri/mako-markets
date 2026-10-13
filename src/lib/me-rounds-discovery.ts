// Which rounds Me reads for one account (Codex ME_ROUNDS R1, MAJOR): not every round ever scheduled, which grew without
// bound (about 12 rounds a day, four reads each, every 10 s), but the rounds the indexer knows the account is in, plus
// every round the indexer cannot vouch for yet. Pure and browser-safe: the route (src/app/api/me/rounds/route.ts)
// answers the wire shape below, use-me-rounds.ts parses it and plans the reads here.
//
// Why nothing the account can claim is missed (the route reads the indexer in this order, each read after the last):
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
// An older answer stays complete: its `indexedThrough` is lower, which only widens the ids read on chain.

/// MakoRoundsV1.MAX_ACTIVE_ROUNDS (mako-contracts/src/MakoRoundsV1.sol).
export const MAX_ACTIVE_ROUNDS = 10;
/// The newest round ids always read on chain, at least every round that can be active at once.
export const ME_ROUNDS_RECENT = 12;
/// More rounds than this past the indexer's last scheduled round means the indexer is stuck or wrong: Me says the
/// rounds part is unavailable instead of reading an unbounded range (12 rounds a day: about ten days).
export const ME_ROUNDS_MAX_UNINDEXED = 120;
/// The indexer may be a little ahead of this poll's roundCount read (it is read later, or the count is cached for a
/// poll); far ahead can only mean it indexes ANOTHER Rounds contract (a redeploy, a preview build on the production
/// indexer), whose ids say nothing about this one: unavailable (adversary on 6469ed3).
export const ME_ROUNDS_MAX_AHEAD = 12;

/// GET /api/me/rounds?account=0x... answers 200 with this. Ids are decimal strings, ascending, without duplicates.
export type MeRoundsDiscoveryWire = { roundIds: string[]; indexedThrough: string };
export type MeRoundsDiscovery = { roundIds: bigint[]; indexedThrough: bigint };

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

/// The route's answer, or null when it is not exactly the wire shape (a null is a failed read, never "no rounds").
export function parseMeRoundsDiscovery(body: unknown): MeRoundsDiscovery | null {
  if (!body || typeof body !== 'object') return null;
  const { roundIds, indexedThrough } = body as Record<string, unknown>;
  if (!Array.isArray(roundIds) || typeof indexedThrough !== 'string' || !DECIMAL.test(indexedThrough)) return null;
  const ids: bigint[] = [];
  for (const raw of roundIds) {
    if (typeof raw !== 'string' || !DECIMAL.test(raw) || raw === '0') return null;
    const id = BigInt(raw);
    if (ids.length > 0 && id <= ids[ids.length - 1]) return null;
    ids.push(id);
  }
  return { roundIds: ids, indexedThrough: BigInt(indexedThrough) };
}

export type MeRoundsPlan = { ok: true; ids: bigint[] } | { ok: false; reason: 'indexer_behind' | 'indexer_ahead' };

/// The round ids to read on chain this poll, ascending: the discovered ids that exist (`<= count`), and every id from
/// the lower of (the indexer's last round + 1) and (count - ME_ROUNDS_RECENT + 1) up to `count`. The number of ids is at
/// most discovered + max(ME_ROUNDS_RECENT, ME_ROUNDS_MAX_UNINDEXED), however many rounds exist.
export function planMeRoundReads(count: bigint, d: MeRoundsDiscovery): MeRoundsPlan {
  if (d.indexedThrough - (count > 0n ? count : 0n) > BigInt(ME_ROUNDS_MAX_AHEAD)) return { ok: false, reason: 'indexer_ahead' };
  if (count <= 0n) return { ok: true, ids: [] };
  if (count - d.indexedThrough > BigInt(ME_ROUNDS_MAX_UNINDEXED)) return { ok: false, reason: 'indexer_behind' };
  const recentFrom = count - BigInt(ME_ROUNDS_RECENT) + 1n;
  const unindexedFrom = d.indexedThrough + 1n;
  let from = recentFrom < unindexedFrom ? recentFrom : unindexedFrom;
  if (from < 1n) from = 1n;
  const out = d.roundIds.filter((id) => id >= 1n && id < from);
  for (let id = from; id <= count; id++) out.push(id);
  return { ok: true, ids: out };
}
