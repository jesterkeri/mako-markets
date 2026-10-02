// MakoMarketsV4 events to entities. Each handler reads the rows it changes once, updates them, and writes them
// back once, so the running totals (pool, wallet, day, category, global) always move together.
//
// Public counts (GlobalStats, DailyStats, CategoryStats) leave out Mako Market's own wallets (src/internal-wallets.ts);
// pool and wallet rows include everyone, because a pool's money is real whoever put it in.

import { indexer, type DailyStats, type EvmOnEventContext, type GlobalStats, type Wallet } from 'envio';

type HandlerContext = EvmOnEventContext;

import { isInternal } from '../internal-wallets';
import { categoryOf, dayOf, positionId, statusOf, walletDayId } from '../totals';

const GLOBAL_ID = 'global';

async function loadGlobal(context: HandlerContext): Promise<GlobalStats> {
  return (
    (await context.GlobalStats.get(GLOBAL_ID)) ?? {
      id: GLOBAL_ID,
      wallets: 0,
      bettors: 0,
      bets: 0,
      volume: 0n,
      pools: 0,
      communityPools: 0,
      poolsSettled: 0,
      poolsRefunded: 0,
      claims: 0,
      claimed: 0n,
      creatorFeesPaid: 0n,
      internalWallets: 0,
      updatedAt: 0,
      updatedBlock: 0,
    }
  );
}

async function loadDay(context: HandlerContext, timestamp: number, global: GlobalStats): Promise<DailyStats> {
  const day = dayOf(timestamp);
  return (
    (await context.DailyStats.get(day.id)) ?? {
      id: day.id,
      dayStart: day.start,
      newWallets: 0,
      activeWallets: 0,
      bets: 0,
      volume: 0n,
      poolsCreated: 0,
      claims: 0,
      claimed: 0n,
      cumulativeWallets: global.wallets,
    }
  );
}

/// The wallet, created on first sight. A new public wallet counts once, in the global total and on its first day.
async function loadWallet(
  context: HandlerContext,
  rawAddress: string,
  timestamp: number,
  global: GlobalStats,
  day: DailyStats,
): Promise<{ wallet: Wallet; global: GlobalStats; day: DailyStats }> {
  const id = rawAddress.toLowerCase();
  const existing = await context.Wallet.get(id);
  if (existing) return { wallet: existing, global, day };
  const internal = isInternal(id);
  const wallet: Wallet = {
    id,
    internal,
    firstSeenAt: timestamp,
    lastActiveAt: timestamp,
    betCount: 0,
    poolsBet: 0,
    poolsCreated: 0,
    staked: 0n,
    claimed: 0n,
    creatorFees: 0n,
    net: 0n,
  };
  if (internal) return { wallet, global: { ...global, internalWallets: global.internalWallets + 1 }, day };
  const wallets = global.wallets + 1;
  return { wallet, global: { ...global, wallets }, day: { ...day, newWallets: day.newWallets + 1, cumulativeWallets: wallets } };
}

/// Counts a public wallet as active on the day once.
async function markActive(context: HandlerContext, wallet: Wallet, day: DailyStats): Promise<DailyStats> {
  if (wallet.internal) return day;
  const id = walletDayId(wallet.id, day.id);
  if (await context.WalletDay.get(id)) return day;
  context.WalletDay.set({ id });
  return { ...day, activeWallets: day.activeWallets + 1 };
}

function stamp(global: GlobalStats, timestamp: number, block: number): GlobalStats {
  return { ...global, updatedAt: timestamp, updatedBlock: block };
}

indexer.onEvent({ contract: 'MakoMarketsV4', event: 'MarketCreated' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const poolId = event.params.id.toString();
  const category = categoryOf(event.params.mType);

  let global = await loadGlobal(context);
  let day = await loadDay(context, ts, global);
  const loaded = await loadWallet(context, event.params.creator, ts, global, day);
  let wallet = loaded.wallet;
  global = loaded.global;
  day = loaded.day;

  context.Pool.set({
    id: poolId,
    creator_id: wallet.id,
    category,
    question: event.params.question,
    oracleRef: event.params.oracleRef,
    closeTime: event.params.closeTime,
    createdAt: ts,
    createdTx: event.transaction.hash,
    totalYes: 0n,
    totalNo: 0n,
    yesBettors: 0,
    noBettors: 0,
    betCount: 0,
    status: 'Open',
    resolvedAt: undefined,
    claimedTotal: 0n,
    creatorFeePaid: 0n,
    creatorFeeForfeited: 0n,
  });

  wallet = { ...wallet, poolsCreated: wallet.poolsCreated + 1, lastActiveAt: ts };
  global = { ...global, pools: global.pools + 1 };
  if (!wallet.internal) {
    global = { ...global, communityPools: global.communityPools + 1 };
    day = { ...day, poolsCreated: day.poolsCreated + 1 };
    const cat = (await context.CategoryStats.get(category)) ?? { id: category, category, pools: 0, bets: 0, volume: 0n };
    context.CategoryStats.set({ ...cat, pools: cat.pools + 1 });
    day = await markActive(context, wallet, day);
  }

  context.Wallet.set(wallet);
  context.DailyStats.set(day);
  context.GlobalStats.set(stamp(global, ts, event.block.number));
});

indexer.onEvent({ contract: 'MakoMarketsV4', event: 'BetPlaced' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const poolId = event.params.id.toString();
  const { isYes, amount } = event.params;

  const pool = await context.Pool.get(poolId);
  if (!pool) throw new Error(`BetPlaced for unknown pool ${poolId} (tx ${event.transaction.hash})`);

  let global = await loadGlobal(context);
  let day = await loadDay(context, ts, global);
  const loaded = await loadWallet(context, event.params.user, ts, global, day);
  let wallet = loaded.wallet;
  global = loaded.global;
  day = loaded.day;

  const posId = positionId(wallet.id, poolId);
  const existing = await context.Position.get(posId);
  const position = existing ?? { id: posId, wallet_id: wallet.id, pool_id: poolId, yes: 0n, no: 0n, claimed: 0n };
  // A side's bettor count moves the first time the wallet stakes on that side, as the contract's counts do.
  const newOnSide = isYes ? position.yes === 0n : position.no === 0n;

  context.Position.set(isYes ? { ...position, yes: position.yes + amount } : { ...position, no: position.no + amount });
  context.Pool.set({
    ...pool,
    totalYes: isYes ? pool.totalYes + amount : pool.totalYes,
    totalNo: isYes ? pool.totalNo : pool.totalNo + amount,
    yesBettors: pool.yesBettors + (isYes && newOnSide ? 1 : 0),
    noBettors: pool.noBettors + (!isYes && newOnSide ? 1 : 0),
    betCount: pool.betCount + 1,
  });
  context.Bet.set({
    id: `${event.block.number}_${event.logIndex}`,
    pool_id: poolId,
    wallet_id: wallet.id,
    isYes,
    amount,
    timestamp: ts,
    txHash: event.transaction.hash,
    internal: wallet.internal,
  });

  wallet = {
    ...wallet,
    betCount: wallet.betCount + 1,
    poolsBet: wallet.poolsBet + (existing ? 0 : 1),
    staked: wallet.staked + amount,
    net: wallet.net - amount,
    lastActiveAt: ts,
  };
  if (!wallet.internal) {
    global = { ...global, bettors: global.bettors + (wallet.betCount === 1 ? 1 : 0), bets: global.bets + 1, volume: global.volume + amount };
    day = { ...day, bets: day.bets + 1, volume: day.volume + amount };
    const cat = (await context.CategoryStats.get(pool.category)) ?? { id: pool.category, category: pool.category, pools: 0, bets: 0, volume: 0n };
    context.CategoryStats.set({ ...cat, bets: cat.bets + 1, volume: cat.volume + amount });
    day = await markActive(context, wallet, day);
  }

  context.Wallet.set(wallet);
  context.DailyStats.set(day);
  context.GlobalStats.set(stamp(global, ts, event.block.number));
});

indexer.onEvent({ contract: 'MakoMarketsV4', event: 'MarketResolved' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const poolId = event.params.id.toString();
  const pool = await context.Pool.get(poolId);
  if (!pool) throw new Error(`MarketResolved for unknown pool ${poolId} (tx ${event.transaction.hash})`);
  const status = statusOf(event.params.outcome);

  context.Pool.set({ ...pool, status, resolvedAt: ts });
  const global = await loadGlobal(context);
  context.GlobalStats.set(
    stamp(
      { ...global, poolsSettled: global.poolsSettled + 1, poolsRefunded: global.poolsRefunded + (status === 'Refund' ? 1 : 0) },
      ts,
      event.block.number,
    ),
  );
});

indexer.onEvent({ contract: 'MakoMarketsV4', event: 'Claimed' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const poolId = event.params.id.toString();
  const { amount } = event.params;
  const pool = await context.Pool.get(poolId);
  if (!pool) throw new Error(`Claimed for unknown pool ${poolId} (tx ${event.transaction.hash})`);

  let global = await loadGlobal(context);
  let day = await loadDay(context, ts, global);
  const loaded = await loadWallet(context, event.params.user, ts, global, day);
  let wallet = loaded.wallet;
  global = loaded.global;
  day = loaded.day;

  const posId = positionId(wallet.id, poolId);
  const position = (await context.Position.get(posId)) ?? { id: posId, wallet_id: wallet.id, pool_id: poolId, yes: 0n, no: 0n, claimed: 0n };
  context.Position.set({ ...position, claimed: position.claimed + amount });
  context.Pool.set({ ...pool, claimedTotal: pool.claimedTotal + amount });
  context.Claim.set({
    id: `${event.block.number}_${event.logIndex}`,
    pool_id: poolId,
    wallet_id: wallet.id,
    amount,
    timestamp: ts,
    txHash: event.transaction.hash,
    internal: wallet.internal,
  });

  wallet = { ...wallet, claimed: wallet.claimed + amount, net: wallet.net + amount, lastActiveAt: ts };
  if (!wallet.internal) {
    global = { ...global, claims: global.claims + 1, claimed: global.claimed + amount };
    day = { ...day, claims: day.claims + 1, claimed: day.claimed + amount };
    day = await markActive(context, wallet, day);
  }

  context.Wallet.set(wallet);
  context.DailyStats.set(day);
  context.GlobalStats.set(stamp(global, ts, event.block.number));
});

indexer.onEvent({ contract: 'MakoMarketsV4', event: 'CreatorFeePaid' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const poolId = event.params.id.toString();
  const { amount } = event.params;
  const pool = await context.Pool.get(poolId);
  if (!pool) throw new Error(`CreatorFeePaid for unknown pool ${poolId} (tx ${event.transaction.hash})`);
  context.Pool.set({ ...pool, creatorFeePaid: amount });

  let global = await loadGlobal(context);
  const day = await loadDay(context, ts, global);
  const loaded = await loadWallet(context, event.params.creator, ts, global, day);
  global = loaded.global;
  const wallet = { ...loaded.wallet, creatorFees: loaded.wallet.creatorFees + amount, net: loaded.wallet.net + amount, lastActiveAt: ts };
  if (!wallet.internal) global = { ...global, creatorFeesPaid: global.creatorFeesPaid + amount };

  context.Wallet.set(wallet);
  context.DailyStats.set(loaded.day);
  context.GlobalStats.set(stamp(global, ts, event.block.number));
});

indexer.onEvent({ contract: 'MakoMarketsV4', event: 'CreatorFeeForfeited' }, async ({ event, context }) => {
  const poolId = event.params.id.toString();
  const pool = await context.Pool.get(poolId);
  if (!pool) throw new Error(`CreatorFeeForfeited for unknown pool ${poolId} (tx ${event.transaction.hash})`);
  context.Pool.set({ ...pool, creatorFeeForfeited: event.params.forgoneAmount });
  // Every handled event moves the index progress /stats shows (Codex S6 r1).
  const global = await loadGlobal(context);
  context.GlobalStats.set(stamp(global, event.block.timestamp, event.block.number));
});
