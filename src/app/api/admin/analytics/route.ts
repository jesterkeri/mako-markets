import { NextResponse } from 'next/server';
import { createPublicClient, formatEther, http, parseAbiItem, type AbiEvent, type Log } from 'viem';
import { monadTestnet } from '@/lib/chain';
import { makoAbi, MAKO_ADDRESS } from '@/lib/contract';
import type { AdminAnalytics } from '@/lib/admin-analytics';

/**
 * GET /api/admin/analytics
 *
 * Aggregates everything the admin dashboard needs:
 *   - Market count & pool totals (via Multicall3 `getMarket` fanout)
 *   - Treasury balance
 *   - Per-address bet count / volume / markets-created (via `getLogs`)
 *   - Recent activity feed (last 200 events, newest first)
 *
 * Why one endpoint instead of four: everything derives from the same
 * on-chain read pass. Splitting per page would quadruple RPC load and
 * the client's query cache already share-fetches via a single queryKey.
 *
 * Caching:
 *   - Server:  module-scoped memo with 30s TTL (survives across requests
 *              on Vercel Fluid Compute since function instances persist)
 *   - Client:  TanStack Query `staleTime: 30_000` in `useAdminAnalytics()`
 *
 * Deliberately NOT using the Next.js 16 `"use cache"` directive because it
 * requires `experimental.cacheComponents: true` in next.config.ts which
 * changes render semantics repo-wide. Not worth the blast radius for one
 * admin route.
 *
 * Data here is already public on-chain — no auth needed on the endpoint.
 * The cosmetic `useIsAdmin()` gate on the pages hides the UI from non-admins.
 */
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 30_000;

type Cached = { data: AdminAnalytics; at: number };
let memo: Cached | null = null;

const DEPLOY_BLOCK = BigInt(
  process.env.NEXT_PUBLIC_MAKO_DEPLOY_BLOCK ?? '0',
);

// Monad public RPC caps `eth_getLogs` range per call. 10k blocks is well
// under the observed limit and keeps the total number of round-trips small
// (50 chunks ≈ 500k blocks covered). Shrink if Monad tightens the cap.
const LOG_CHUNK = 10_000n;

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

const client = createPublicClient({
  chain: monadTestnet,
  transport: http(),
});

async function chunkedGetLogs(
  event: AbiEvent,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const out: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > toBlock ? toBlock : start + LOG_CHUNK - 1n;
    const logs = await client.getLogs({
      address: MAKO_ADDRESS,
      event,
      fromBlock: start,
      toBlock: end,
    });
    // Narrow logs lose their typed `args` via this generic signature; every
    // call site re-casts `args` based on the specific event definition above.
    out.push(...(logs as unknown as Log[]));
  }
  return out;
}

// Fetch block timestamps for a set of unique block numbers, bounded-parallel.
async function resolveTimestamps(blockNumbers: Iterable<bigint>): Promise<Map<string, number>> {
  const uniq = Array.from(new Set(Array.from(blockNumbers, (b) => b.toString())));
  const out = new Map<string, number>();
  const CONCURRENCY = 20;
  for (let i = 0; i < uniq.length; i += CONCURRENCY) {
    const slice = uniq.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (bn) => {
        const block = await client.getBlock({ blockNumber: BigInt(bn) });
        return [bn, Number(block.timestamp)] as const;
      }),
    );
    for (const [bn, ts] of results) out.set(bn, ts);
  }
  return out;
}

async function aggregate(): Promise<AdminAnalytics> {
  // 1. Market count + treasury, then 2. Multicall `getMarket` fanout
  const [nextIdBn, treasuryBn, latestBlock] = await Promise.all([
    client.readContract({ address: MAKO_ADDRESS, abi: makoAbi, functionName: 'nextMarketId' }),
    client.readContract({ address: MAKO_ADDRESS, abi: makoAbi, functionName: 'treasuryBalance' }),
    client.getBlockNumber(),
  ]);
  const count = Number(nextIdBn);

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

  // Sum volume in wei during the mapping pass — keep bigints until we stringify.
  // Going through parseFloat would silently lose precision at higher totals.
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

  // 3. Event logs in parallel, each chunked
  const [betLogs, marketLogs, resolveLogs, claimLogs, feeLogs] = await Promise.all([
    chunkedGetLogs(eventBetPlaced, DEPLOY_BLOCK, latestBlock).catch((e) => {
      console.error('[admin-analytics] BetPlaced getLogs failed:', e);
      return [] as Log[];
    }),
    chunkedGetLogs(eventMarketCreated, DEPLOY_BLOCK, latestBlock).catch((e) => {
      console.error('[admin-analytics] MarketCreated getLogs failed:', e);
      return [] as Log[];
    }),
    chunkedGetLogs(eventMarketResolved, DEPLOY_BLOCK, latestBlock).catch((e) => {
      console.error('[admin-analytics] MarketResolved getLogs failed:', e);
      return [] as Log[];
    }),
    chunkedGetLogs(eventClaimed, DEPLOY_BLOCK, latestBlock).catch((e) => {
      console.error('[admin-analytics] Claimed getLogs failed:', e);
      return [] as Log[];
    }),
    chunkedGetLogs(eventCreatorFeePaid, DEPLOY_BLOCK, latestBlock).catch((e) => {
      console.error('[admin-analytics] CreatorFeePaid getLogs failed:', e);
      return [] as Log[];
    }),
  ]);

  // 4. Resolve block timestamps (dedup first)
  const allBlocks: bigint[] = [
    ...betLogs.map((l) => l.blockNumber!),
    ...marketLogs.map((l) => l.blockNumber!),
    ...resolveLogs.map((l) => l.blockNumber!),
    ...claimLogs.map((l) => l.blockNumber!),
    ...feeLogs.map((l) => l.blockNumber!),
  ];
  const tsByBlock = await resolveTimestamps(allBlocks);
  const tsOf = (bn: bigint) => tsByBlock.get(bn.toString()) ?? 0;

  // 5. Aggregate users
  type UserAcc = {
    address: `0x${string}`;
    betCount: number;
    volumeWei: bigint;
    marketsCreated: number;
    firstSeenSec: number;
    lastSeenSec: number;
  };
  const users = new Map<string, UserAcc>();

  const touch = (addr: `0x${string}`, ts: number) => {
    const key = addr.toLowerCase();
    const existing = users.get(key);
    if (!existing) {
      users.set(key, {
        address: addr,
        betCount: 0,
        volumeWei: 0n,
        marketsCreated: 0,
        firstSeenSec: ts,
        lastSeenSec: ts,
      });
      return users.get(key)!;
    }
    if (ts < existing.firstSeenSec || existing.firstSeenSec === 0) existing.firstSeenSec = ts;
    if (ts > existing.lastSeenSec) existing.lastSeenSec = ts;
    return existing;
  };

  const uniqueBettors = new Set<string>();
  const uniqueCreators = new Set<string>();

  for (const l of betLogs) {
    const args = (l as unknown as { args: { id: bigint; user: `0x${string}`; isYes: boolean; amount: bigint } }).args;
    const ts = tsOf(l.blockNumber!);
    const acc = touch(args.user, ts);
    acc.betCount += 1;
    acc.volumeWei += args.amount;
    uniqueBettors.add(args.user.toLowerCase());
  }
  for (const l of marketLogs) {
    const args = (l as unknown as { args: { id: bigint; creator: `0x${string}` } }).args;
    const ts = tsOf(l.blockNumber!);
    const acc = touch(args.creator, ts);
    acc.marketsCreated += 1;
    uniqueCreators.add(args.creator.toLowerCase());
  }

  // Sort by raw wei volume (bigint comparison — exact, no float precision loss).
  // Tie-break by lastSeenSec so the freshest activity rises in a tie.
  const usersArray = Array.from(users.values())
    .sort((a, b) => {
      if (a.volumeWei !== b.volumeWei) return b.volumeWei > a.volumeWei ? 1 : -1;
      return b.lastSeenSec - a.lastSeenSec;
    })
    .map((u) => ({
      address: u.address,
      betCount: u.betCount,
      volumeMon: formatEther(u.volumeWei),
      marketsCreated: u.marketsCreated,
      firstSeenSec: u.firstSeenSec,
      lastSeenSec: u.lastSeenSec,
    }));

  // 6. Build activity feed (newest first, cap at 200)
  type Activity = AdminAnalytics['activity'][number];
  const activity: Activity[] = [];

  for (const l of betLogs) {
    const a = (l as unknown as { args: { id: bigint; user: `0x${string}`; isYes: boolean; amount: bigint } }).args;
    activity.push({
      kind: 'bet',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      user: a.user,
      amountMon: formatEther(a.amount),
      isYes: a.isYes,
    });
  }
  for (const l of marketLogs) {
    const a = (l as unknown as { args: { id: bigint; creator: `0x${string}` } }).args;
    activity.push({
      kind: 'market',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      user: a.creator,
    });
  }
  for (const l of resolveLogs) {
    const a = (l as unknown as { args: { id: bigint; outcome: number } }).args;
    activity.push({
      kind: 'resolve',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      outcome: a.outcome as 0 | 1 | 2 | 3,
    });
  }
  for (const l of claimLogs) {
    const a = (l as unknown as { args: { id: bigint; user: `0x${string}`; amount: bigint } }).args;
    activity.push({
      kind: 'claim',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      user: a.user,
      amountMon: formatEther(a.amount),
    });
  }
  for (const l of feeLogs) {
    const a = (l as unknown as { args: { id: bigint; creator: `0x${string}`; amount: bigint } }).args;
    activity.push({
      kind: 'fee',
      marketId: a.id.toString(),
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!.toString(),
      tsSec: tsOf(l.blockNumber!),
      user: a.creator,
      amountMon: formatEther(a.amount),
    });
  }

  activity.sort((a, b) => {
    const bb = BigInt(b.blockNumber);
    const ab = BigInt(a.blockNumber);
    if (bb !== ab) return bb > ab ? 1 : -1;
    return 0;
  });
  const cappedActivity = activity.slice(0, 200);

  const resolvedCount = markets.filter((m) => m.resolved).length;
  const nowSec = Math.floor(Date.now() / 1000);
  const pendingResolveCount = markets.filter((m) => !m.resolved && m.closeTimeSec <= nowSec).length;
  const unresolvedOpenCount = markets.filter((m) => !m.resolved && m.closeTimeSec > nowSec).length;

  // Daily active wallets for the last 30 days, derived from BetPlaced events.
  // Bucketed in UTC so the boundaries don't drift by viewer timezone.
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

  return {
    totals: {
      marketCount: markets.length,
      resolvedCount,
      unresolvedOpenCount,
      pendingResolveCount,
      totalVolumeMon: formatEther(totalVolumeWei),
      uniqueBettors: uniqueBettors.size,
      uniqueCreators: uniqueCreators.size,
      treasuryMon: formatEther(treasuryBn as bigint),
      fetchedAtSec: nowSec,
    },
    users: usersArray,
    markets,
    activity: cappedActivity,
    dau,
  };
}

export async function GET() {
  try {
    if (memo && Date.now() - memo.at < CACHE_TTL_MS) {
      return NextResponse.json(memo.data, {
        headers: { 'x-admin-cache': 'HIT' },
      });
    }
    const data = await aggregate();
    memo = { data, at: Date.now() };
    return NextResponse.json(data, {
      headers: { 'x-admin-cache': 'MISS' },
    });
  } catch (e) {
    console.error('[admin-analytics] aggregate failed:', e);
    return NextResponse.json({ error: 'upstream' }, { status: 503 });
  }
}
