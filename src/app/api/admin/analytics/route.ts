import { NextResponse } from 'next/server';
import {
  createPublicClient,
  formatEther,
  http,
  parseAbiItem,
  type AbiEvent,
  type Log,
} from 'viem';
import { monadTestnet } from '@/lib/chain';
import { makoAbi, MAKO_ADDRESS } from '@/lib/contract';
import type { AdminAnalytics } from '@/lib/admin-analytics';

/**
 * GET /api/admin/analytics
 *
 * Aggregates everything the admin dashboard needs:
 *   - Market count & pool totals (via Multicall3 `getMarket` fanout)
 *   - Treasury balance + cumulative protocol + creator fees
 *   - Per-address bet count / volume / markets-created / claimed /
 *     creator-fees-earned (via `getLogs`)
 *   - Recent activity feed (last 200 events, newest first, chain-ordered)
 *
 * Why one endpoint instead of many: everything derives from the same
 * on-chain read pass. Splitting per-page would multiply RPC load and
 * the client's query cache already share-fetches via a single queryKey.
 *
 * Caching:
 *   - Server:  module-scoped memo with 30s TTL + in-flight promise coalesce
 *              — coalesces burst within a SINGLE function instance only.
 *              Vercel Fluid runs multiple warm instances in parallel; each
 *              one keeps its own memo, so a 30s refresh can still trigger
 *              1× RPC fanout per live instance. If that becomes a cost
 *              problem at scale, add a shared cache layer (Blob / KV / Redis)
 *              — scope for a later round.
 *   - Incremental: a `lastScannedBlock` cursor + in-memory event store
 *              means every cache miss after the first only issues getLogs
 *              for the delta since last scan (~30 blocks on a 30s loop,
 *              not 450k+). Drops steady-state CU per aggregate from ~207k
 *              to ~550, making PAYG viable for long-lived tabs.
 *   - Client:  TanStack Query `staleTime: 30_000` in `useAdminAnalytics()`.
 *
 * Not using Next.js 16 `"use cache"` because that requires enabling
 * `cacheComponents` globally and changes render semantics app-wide —
 * too big a blast radius for one admin route.
 *
 * Data here is already public on-chain, so the endpoint is unauthenticated;
 * the cosmetic `useIsAdmin()` gate on the pages hides the UI from non-admins
 * and (with `enabled: isAdmin` on the client hook) stops non-admins from
 * warming up the cache by opening the page.
 */
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 30_000;

type Cached = { data: AdminAnalytics; at: number };
let memo: Cached | null = null;
// Coalesce concurrent cold-cache requests: every caller awaits the same
// in-flight promise instead of triggering parallel full-history scans.
// The promise itself writes to `memo` BEFORE clearing `inFlight`, so
// there's no window where a second caller can see both `inFlight = null`
// and `memo` stale. Per-instance only — see header note on caching.
let inFlight: Promise<AdminAnalytics> | null = null;

/**
 * Incremental-scan state (per function instance).
 *
 * `lastScannedBlock` is the highest block number we've already pulled logs
 * for. On the next cache miss we only scan `lastScannedBlock + 1 → latest`
 * instead of DEPLOY_BLOCK → latest, which drops per-aggregate RPC cost
 * from ~207k CU to ~550 CU in steady state.
 *
 * `eventStore` accumulates the raw logs so the aggregation pass can
 * re-derive users / activity / DAU / userGrowth on every call. CPU is
 * cheap; it's the RPC calls we're cutting.
 *
 * `blockTsCache` caches block timestamps across ticks so we don't re-fetch
 * the same block's timestamp every 30s just to re-label existing events.
 *
 * All three reset on process restart / cold start, which makes the first
 * request after a cold start do a full scan (expected, amortized across
 * the instance's lifetime).
 */
let lastScannedBlock: bigint | null = null;
type StreamKey = 'bet' | 'market' | 'resolve' | 'claim' | 'fee' | 'withdraw';
const eventStore: Record<StreamKey, Log[]> = {
  bet: [],
  market: [],
  resolve: [],
  claim: [],
  fee: [],
  withdraw: [],
};
const blockTsCache = new Map<string, number>();

function evictBelow(floor: bigint) {
  for (const key of Object.keys(eventStore) as StreamKey[]) {
    eventStore[key] = eventStore[key].filter((l) => (l.blockNumber ?? 0n) >= floor);
  }
}

const DEPLOY_BLOCK_RAW = process.env.NEXT_PUBLIC_MAKO_DEPLOY_BLOCK;
const DEPLOY_BLOCK = BigInt(DEPLOY_BLOCK_RAW ?? '0');

// Monad's public RPC returns `-32614: eth_getLogs is limited to a 100 range`
// for anything wider. Private RPCs (Alchemy, dRPC, Ankr) allow ~10k+.
// Start at 100 as the safe floor; bump via env when a real RPC is wired up.
const LOG_CHUNK: bigint = BigInt(process.env.ADMIN_ANALYTICS_LOG_CHUNK ?? '100');

// Parallelize chunked scans. 5 concurrent = throughput without hammering
// rate-limited public RPC. Scales up naturally with a private RPC URL.
const CHUNK_CONCURRENCY = Number(process.env.ADMIN_ANALYTICS_CONCURRENCY ?? '5');

// Default lookback window when no private RPC is configured. 10k blocks
// ≈ 3h of Monad testnet at ~1s block time. Keeps the cold-cache scan
// comfortably under 10s against public RPC's 100-block getLogs cap + its
// aggressive rate limiting. Wider windows (overnight, weekly) want a
// private RPC via MONAD_RPC_URL.
// Overridable via ADMIN_ANALYTICS_LOOKBACK_BLOCKS; set to 0 to disable
// the window (scan from DEPLOY_BLOCK to latest — only safe on private RPC).
const DEFAULT_LOOKBACK = 10_000n;

const MONAD_RPC_URL = process.env.MONAD_RPC_URL;
const LOOKBACK_RAW = process.env.ADMIN_ANALYTICS_LOOKBACK_BLOCKS;
const LOOKBACK_BLOCKS: bigint = LOOKBACK_RAW !== undefined
  ? BigInt(LOOKBACK_RAW)
  : (MONAD_RPC_URL ? 0n : DEFAULT_LOOKBACK);

const eventBetPlaced = parseAbiItem(
  'event BetPlaced(uint256 indexed id, address indexed user, bool isYes, uint256 amount)',
);
const eventMarketCreated = parseAbiItem(
  'event MarketCreated(uint256 indexed id, address indexed creator, uint8 mType, bytes32 oracleRef, uint64 closeTime, string question)',
);
const eventMarketResolved = parseAbiItem(
  'event MarketResolved(uint256 indexed id, uint8 outcome)',
);
const eventClaimed = parseAbiItem(
  'event Claimed(uint256 indexed id, address indexed user, uint256 amount)',
);
const eventCreatorFeePaid = parseAbiItem(
  'event CreatorFeePaid(uint256 indexed id, address indexed creator, uint256 amount)',
);
const eventTreasuryWithdrawn = parseAbiItem(
  'event TreasuryWithdrawn(uint256 amount)',
);

const client = createPublicClient({
  chain: monadTestnet,
  transport: http(MONAD_RPC_URL),
});

async function chunkedGetLogs(
  event: AbiEvent,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  // Build the full range upfront, then fire batches of CHUNK_CONCURRENCY
  // in parallel. Serial 100-block scans over 400k+ blocks take minutes;
  // parallel scans finish in seconds on a good RPC.
  const ranges: Array<[bigint, bigint]> = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > toBlock ? toBlock : start + LOG_CHUNK - 1n;
    ranges.push([start, end]);
  }
  const out: Log[] = [];
  for (let i = 0; i < ranges.length; i += CHUNK_CONCURRENCY) {
    const batch = ranges.slice(i, i + CHUNK_CONCURRENCY);
    const results = await Promise.all(
      batch.map(([start, end]) =>
        client.getLogs({
          address: MAKO_ADDRESS,
          event,
          fromBlock: start,
          toBlock: end,
        }),
      ),
    );
    for (const r of results) {
      out.push(...(r as unknown as Log[]));
    }
  }
  return out;
}

async function resolveTimestamps(blockNumbers: Iterable<bigint>): Promise<void> {
  // Populate `blockTsCache` only for blocks we haven't fetched before.
  // Previous revision returned a fresh Map per call, which meant we
  // re-paid for every event's timestamp on every 30s tick even when
  // we already knew the answer.
  const needed = new Set<string>();
  for (const b of blockNumbers) {
    const k = b.toString();
    if (!blockTsCache.has(k)) needed.add(k);
  }
  if (needed.size === 0) return;
  const CONCURRENCY = 20;
  const list = Array.from(needed);
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const slice = list.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (bn) => {
        const block = await client.getBlock({ blockNumber: BigInt(bn) });
        return [bn, Number(block.timestamp)] as const;
      }),
    );
    for (const [bn, ts] of results) blockTsCache.set(bn, ts);
  }
}

async function aggregate(): Promise<AdminAnalytics> {
  // Module-level "production deploy block required" guard. Missing env
  // in prod silently falls back to block 0, which would scan the entire
  // chain on every cold cache — a DoS amplifier against Monad's public RPC.
  if (!DEPLOY_BLOCK_RAW && process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_MAKO_DEPLOY_BLOCK env is required in production. ' +
        'Grab it from ../mako-contracts/broadcast/Deploy.s.sol/10143/run-latest.json.',
    );
  }

  const degraded: string[] = [];
  const wrapStream = async <T>(name: string, p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      console.error(`[admin-analytics] ${name} stream failed:`, e);
      degraded.push(name);
      return null;
    }
  };

  const [nextIdBn, treasuryBn, latestBlock] = await Promise.all([
    client.readContract({ address: MAKO_ADDRESS, abi: makoAbi, functionName: 'nextMarketId' }),
    client.readContract({ address: MAKO_ADDRESS, abi: makoAbi, functionName: 'treasuryBalance' }),
    client.getBlockNumber(),
  ]);
  const count = Number(nextIdBn);

  // Effective scan range: floor at DEPLOY_BLOCK, optionally clamp to a
  // rolling window so we're not trying to scan 15M blocks against a
  // rate-limited public RPC. The UI shows the range so "only real data"
  // always means "real data for the visible window."
  const windowedFrom = LOOKBACK_BLOCKS > 0n && latestBlock > LOOKBACK_BLOCKS
    ? latestBlock - LOOKBACK_BLOCKS
    : 0n;
  const scanFrom = windowedFrom > DEPLOY_BLOCK ? windowedFrom : DEPLOY_BLOCK;
  const scanTo = latestBlock;

  const marketResults =
    count === 0
      ? []
      : await client.multicall({
          contracts: Array.from({ length: count }, (_, i) => ({
            address: MAKO_ADDRESS,
            abi: makoAbi,
            functionName: 'getMarket' as const,
            args: [BigInt(i)] as const,
          })),
          allowFailure: true,
        });

  // Sum volume in wei during the mapping pass — keep bigints until we
  // stringify. parseFloat round-trips would lose precision at higher totals.
  let totalVolumeWei = 0n;

  const markets = marketResults
    .map((r, i) => {
      if (r.status !== 'success' || !r.result) return null;
      const m = r.result as {
        creator: `0x${string}`;
        mType: number;
        oracleRef: `0x${string}`;
        question: string;
        createdAt: bigint;
        closeTime: bigint;
        totalYes: bigint;
        totalNo: bigint;
        yesBettorCount: number;
        noBettorCount: number;
        outcome: number;
        resolved: boolean;
        creatorFeeClaimed: boolean;
      };
      totalVolumeWei += m.totalYes + m.totalNo;
      return {
        id: BigInt(i).toString(),
        mType: m.mType as 0 | 1 | 2,
        creator: m.creator,
        question: m.question,
        createdAtSec: Number(m.createdAt),
        closeTimeSec: Number(m.closeTime),
        poolMon: formatEther(m.totalYes + m.totalNo),
        yesMon: formatEther(m.totalYes),
        noMon: formatEther(m.totalNo),
        bettorCount: m.yesBettorCount + m.noBettorCount,
        outcome: m.outcome as 0 | 1 | 2 | 3,
        resolved: m.resolved,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Incremental scan. If we've never scanned, or the cursor is stale
  // relative to the current bounded window (can happen if LOOKBACK_BLOCKS
  // shrinks between ticks or if latestBlock jumps forward far enough that
  // the cursor is older than the window floor), do a full scan. Otherwise
  // only scan `lastScannedBlock + 1 → latestBlock`.
  const cursorUsable =
    lastScannedBlock !== null &&
    lastScannedBlock >= scanFrom &&
    lastScannedBlock <= scanTo;
  const deltaFrom = cursorUsable ? lastScannedBlock! + 1n : scanFrom;
  const deltaTo = scanTo;

  // If there are no new blocks since the last scan, skip RPC entirely
  // and re-aggregate from the cached eventStore.
  const hasDelta = deltaFrom <= deltaTo;

  if (hasDelta) {
    const [betLogs, marketLogs, resolveLogs, claimLogs, feeLogs, withdrawLogs] =
      (await Promise.all([
        wrapStream('bet', chunkedGetLogs(eventBetPlaced, deltaFrom, deltaTo)),
        wrapStream('market', chunkedGetLogs(eventMarketCreated, deltaFrom, deltaTo)),
        wrapStream('resolve', chunkedGetLogs(eventMarketResolved, deltaFrom, deltaTo)),
        wrapStream('claim', chunkedGetLogs(eventClaimed, deltaFrom, deltaTo)),
        wrapStream('fee', chunkedGetLogs(eventCreatorFeePaid, deltaFrom, deltaTo)),
        wrapStream('withdraw', chunkedGetLogs(eventTreasuryWithdrawn, deltaFrom, deltaTo)),
      ])).map((l) => l ?? []) as [Log[], Log[], Log[], Log[], Log[], Log[]];

    // If this was a full scan (cursor wasn't usable), reset the store
    // so we don't mix pre-window leftovers with the fresh full set.
    if (!cursorUsable) {
      for (const k of Object.keys(eventStore) as StreamKey[]) eventStore[k] = [];
    }
    eventStore.bet.push(...betLogs);
    eventStore.market.push(...marketLogs);
    eventStore.resolve.push(...resolveLogs);
    eventStore.claim.push(...claimLogs);
    eventStore.fee.push(...feeLogs);
    eventStore.withdraw.push(...withdrawLogs);
    lastScannedBlock = scanTo;
  }

  // In bounded mode, evict events whose block is older than the current
  // window floor. Cheap filter, keeps the "LAST N BLOCKS" chart honest.
  if (scanFrom > DEPLOY_BLOCK) {
    evictBelow(scanFrom);
  }

  // Pull the full working set out of the store for the aggregation pass.
  const betLogs = eventStore.bet;
  const marketLogs = eventStore.market;
  const resolveLogs = eventStore.resolve;
  const claimLogs = eventStore.claim;
  const feeLogs = eventStore.fee;
  const withdrawLogs = eventStore.withdraw;

  // Resolve block timestamps for anything not already cached. Iterates the
  // full store but `resolveTimestamps` short-circuits on cache hits, so in
  // steady state this only issues RPC calls for the delta blocks.
  const allBlocks: bigint[] = [
    ...betLogs.map((l) => l.blockNumber!),
    ...marketLogs.map((l) => l.blockNumber!),
    ...resolveLogs.map((l) => l.blockNumber!),
    ...claimLogs.map((l) => l.blockNumber!),
    ...feeLogs.map((l) => l.blockNumber!),
    ...withdrawLogs.map((l) => l.blockNumber!),
  ];
  await resolveTimestamps(allBlocks);
  const tsOf = (bn: bigint) => blockTsCache.get(bn.toString()) ?? 0;

  // --- Users aggregation ---
  type UserAcc = {
    address: `0x${string}`;
    betCount: number;
    volumeWei: bigint;
    marketsCreated: number;
    creatorFeesEarnedWei: bigint;
    claimedWei: bigint;
    firstSeenSec: number;
    lastSeenSec: number;
  };
  const users = new Map<string, UserAcc>();

  const touch = (addr: `0x${string}`, ts: number): UserAcc => {
    const key = addr.toLowerCase();
    const existing = users.get(key);
    if (!existing) {
      const fresh: UserAcc = {
        address: addr,
        betCount: 0,
        volumeWei: 0n,
        marketsCreated: 0,
        creatorFeesEarnedWei: 0n,
        claimedWei: 0n,
        firstSeenSec: ts || 0,
        lastSeenSec: ts || 0,
      };
      users.set(key, fresh);
      return fresh;
    }
    if (ts && (ts < existing.firstSeenSec || existing.firstSeenSec === 0)) {
      existing.firstSeenSec = ts;
    }
    if (ts && ts > existing.lastSeenSec) existing.lastSeenSec = ts;
    return existing;
  };

  const uniqueBettors = new Set<string>();
  const uniqueCreators = new Set<string>();

  for (const l of betLogs) {
    const args = (l as unknown as { args: { id: bigint; user: `0x${string}`; isYes: boolean; amount: bigint } }).args;
    const acc = touch(args.user, tsOf(l.blockNumber!));
    acc.betCount += 1;
    acc.volumeWei += args.amount;
    uniqueBettors.add(args.user.toLowerCase());
  }
  for (const l of marketLogs) {
    const args = (l as unknown as { args: { id: bigint; creator: `0x${string}` } }).args;
    const acc = touch(args.creator, tsOf(l.blockNumber!));
    acc.marketsCreated += 1;
    uniqueCreators.add(args.creator.toLowerCase());
  }
  // Claims and creator-fee payouts are real activity — they must push
  // firstSeen/lastSeen forward so the users page doesn't show a stale
  // "LAST SEEN" for a user who only interacts via claim/fee now.
  for (const l of claimLogs) {
    const args = (l as unknown as { args: { id: bigint; user: `0x${string}`; amount: bigint } }).args;
    const acc = touch(args.user, tsOf(l.blockNumber!));
    acc.claimedWei += args.amount;
  }
  let creatorFeesPaidWei = 0n;
  for (const l of feeLogs) {
    const args = (l as unknown as { args: { id: bigint; creator: `0x${string}`; amount: bigint } }).args;
    const acc = touch(args.creator, tsOf(l.blockNumber!));
    acc.creatorFeesEarnedWei += args.amount;
    creatorFeesPaidWei += args.amount;
  }

  // Sort by raw wei (exact bigint compare, no float precision loss),
  // then by lastSeen as tie-breaker.
  const usersArray = Array.from(users.values())
    .sort((a, b) => {
      if (a.volumeWei !== b.volumeWei) return b.volumeWei > a.volumeWei ? 1 : -1;
      return b.lastSeenSec - a.lastSeenSec;
    })
    .map((u) => ({
      address: u.address,
      betCount: u.betCount,
      volumeMon: formatEther(u.volumeWei),
      volumeWei: u.volumeWei.toString(),
      marketsCreated: u.marketsCreated,
      creatorFeesEarnedMon: formatEther(u.creatorFeesEarnedWei),
      creatorFeesEarnedWei: u.creatorFeesEarnedWei.toString(),
      claimedMon: formatEther(u.claimedWei),
      firstSeenSec: u.firstSeenSec,
      lastSeenSec: u.lastSeenSec,
    }));

  // --- Activity feed ---
  type Activity = AdminAnalytics['activity'][number];
  // Composite chain-order tuple per event so same-block events sort by
  // their true position (blockNumber > transactionIndex > logIndex), not
  // by the order we happened to push them in.
  type Entry = Activity & {
    _blockN: bigint;
    _txIdx: number;
    _logIdx: number;
  };
  const entries: Entry[] = [];

  const chainKey = (l: Log) => ({
    _blockN: l.blockNumber!,
    _txIdx: Number(l.transactionIndex ?? 0),
    _logIdx: Number(l.logIndex ?? 0),
  });

  for (const l of betLogs) {
    const a = (l as unknown as { args: { id: bigint; user: `0x${string}`; isYes: boolean; amount: bigint } }).args;
    entries.push({
      kind: 'bet',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      user: a.user,
      amountMon: formatEther(a.amount),
      isYes: a.isYes,
      ...chainKey(l),
    });
  }
  for (const l of marketLogs) {
    const a = (l as unknown as { args: { id: bigint; creator: `0x${string}` } }).args;
    entries.push({
      kind: 'market',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      user: a.creator,
      ...chainKey(l),
    });
  }
  for (const l of resolveLogs) {
    const a = (l as unknown as { args: { id: bigint; outcome: number } }).args;
    entries.push({
      kind: 'resolve',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      outcome: a.outcome as 0 | 1 | 2 | 3,
      ...chainKey(l),
    });
  }
  for (const l of claimLogs) {
    const a = (l as unknown as { args: { id: bigint; user: `0x${string}`; amount: bigint } }).args;
    entries.push({
      kind: 'claim',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      user: a.user,
      amountMon: formatEther(a.amount),
      ...chainKey(l),
    });
  }
  for (const l of feeLogs) {
    const a = (l as unknown as { args: { id: bigint; creator: `0x${string}`; amount: bigint } }).args;
    entries.push({
      kind: 'fee',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      user: a.creator,
      amountMon: formatEther(a.amount),
      ...chainKey(l),
    });
  }

  entries.sort((a, b) => {
    if (a._blockN !== b._blockN) return b._blockN > a._blockN ? 1 : -1;
    if (a._txIdx !== b._txIdx) return b._txIdx - a._txIdx;
    return b._logIdx - a._logIdx;
  });
  const cappedActivity: Activity[] = entries.slice(0, 200).map((e) => {
    // Strip the private chain-order helper fields from the wire shape.
    const { _blockN, _txIdx, _logIdx, ...wire } = e;
    void _blockN;
    void _txIdx;
    void _logIdx;
    return wire;
  });

  // --- DAU (30-day bucket, UTC) ---
  const DAYS = 30;
  const dayMs = 24 * 60 * 60 * 1000;
  const todayUtc = new Date(Date.now());
  todayUtc.setUTCHours(0, 0, 0, 0);
  const bucket = new Map<string, { wallets: Set<string>; bets: number }>();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(todayUtc.getTime() - i * dayMs);
    bucket.set(d.toISOString().slice(0, 10), { wallets: new Set(), bets: 0 });
  }
  for (const l of betLogs) {
    const ts = tsOf(l.blockNumber!);
    if (!ts) continue;
    const key = new Date(ts * 1000).toISOString().slice(0, 10);
    const slot = bucket.get(key);
    if (!slot) continue;
    const args = (l as unknown as { args: { user: `0x${string}` } }).args;
    slot.wallets.add(args.user.toLowerCase());
    slot.bets += 1;
  }
  const dau = Array.from(bucket.entries()).map(([dateISO, slot]) => ({
    dateISO,
    wallets: slot.wallets.size,
    bets: slot.bets,
  }));

  // --- Cumulative user growth (30-day window, UTC) ---
  // "User" = any address that has either bet or created a market. Track
  // the first day each unique address appeared, then fold into a running
  // total. Pre-window first-seens land in the baseline (added to the
  // starting cumulative so the curve doesn't start at zero when we have
  // users from before the chart window).
  const firstSeenDay = new Map<string, string>();
  const noteFirstSeen = (addr: `0x${string}`, blockNumber: bigint) => {
    const ts = tsOf(blockNumber);
    if (!ts) return;
    const day = new Date(ts * 1000).toISOString().slice(0, 10);
    const key = addr.toLowerCase();
    const existing = firstSeenDay.get(key);
    if (!existing || day < existing) firstSeenDay.set(key, day);
  };
  for (const l of betLogs) {
    const a = (l as unknown as { args: { user: `0x${string}` } }).args;
    noteFirstSeen(a.user, l.blockNumber!);
  }
  for (const l of marketLogs) {
    const a = (l as unknown as { args: { creator: `0x${string}` } }).args;
    noteFirstSeen(a.creator, l.blockNumber!);
  }

  const windowStartDay = Array.from(bucket.keys())[0];
  let cumulative = 0;
  const newByDay = new Map<string, number>();
  for (const [, day] of firstSeenDay) {
    if (day < windowStartDay) {
      cumulative += 1;
    } else {
      newByDay.set(day, (newByDay.get(day) ?? 0) + 1);
    }
  }
  const userGrowth = Array.from(bucket.keys()).map((dateISO) => {
    const newUsers = newByDay.get(dateISO) ?? 0;
    cumulative += newUsers;
    return { dateISO, cumulativeUsers: cumulative, newUsers };
  });

  // --- Totals ---
  const resolvedCount = markets.filter((m) => m.resolved).length;
  const nowSec = Math.floor(Date.now() / 1000);
  const pendingResolveCount = markets.filter((m) => !m.resolved && m.closeTimeSec <= nowSec).length;
  const unresolvedOpenCount = markets.filter((m) => !m.resolved && m.closeTimeSec > nowSec).length;
  const treasuryWei = treasuryBn as bigint;
  // `treasuryBalance()` is "what's in the contract now" — once the owner
  // calls `withdrawTreasury()` the balance resets. Summing TreasuryWithdrawn
  // events + the current balance gives cumulative protocol fees ever earned.
  const withdrawnWei = withdrawLogs.reduce((acc, l) => {
    const args = (l as unknown as { args: { amount: bigint } }).args;
    return acc + args.amount;
  }, 0n);

  return {
    degraded,
    window: {
      fromBlock: scanFrom.toString(),
      toBlock: scanTo.toString(),
      blocksCovered: (scanTo - scanFrom + 1n).toString(),
      /**
       * True when a lookback window is actively clipping history.
       * When true the UI should label totals like VOLUME / USERS /
       * CREATOR FEES as scoped ("LAST N BLOCKS") rather than lifetime.
       */
      bounded: scanFrom > DEPLOY_BLOCK,
    },
    totals: {
      marketCount: markets.length,
      resolvedCount,
      unresolvedOpenCount,
      pendingResolveCount,
      totalVolumeMon: formatEther(totalVolumeWei),
      uniqueBettors: uniqueBettors.size,
      uniqueCreators: uniqueCreators.size,
      treasuryMon: formatEther(treasuryWei),
      creatorFeesPaidMon: formatEther(creatorFeesPaidWei),
      totalProtocolFeesMon: formatEther(treasuryWei + withdrawnWei),
      fetchedAtSec: nowSec,
    },
    users: usersArray,
    markets,
    activity: cappedActivity,
    dau,
    userGrowth,
  };
}

export async function GET() {
  try {
    if (memo && Date.now() - memo.at < CACHE_TTL_MS) {
      return NextResponse.json(memo.data, {
        headers: { 'x-admin-cache': 'HIT' },
      });
    }
    // Coalesce concurrent cold-cache callers onto the same aggregation.
    // Critical: memo is written INSIDE the shared promise chain, BEFORE
    // `inFlight` gets cleared. Previous version assigned memo in the
    // outer async body, which left a gap where a second caller could see
    // `inFlight === null` while memo was still stale and kick off a
    // redundant aggregate. Doing both atomically inside `.then()` closes
    // the gap.
    if (!inFlight) {
      inFlight = aggregate()
        .then((data) => {
          memo = { data, at: Date.now() };
          return data;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    const data = await inFlight;
    return NextResponse.json(data, {
      headers: { 'x-admin-cache': 'MISS' },
    });
  } catch (e) {
    console.error('[admin-analytics] aggregate failed:', e);
    return NextResponse.json(
      { error: 'upstream', message: (e as Error).message },
      { status: 503 },
    );
  }
}
