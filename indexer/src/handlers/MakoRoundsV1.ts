// MakoRoundsV1 events to entities: 15-minute BTC/USD rounds. Same discipline as the pools handler: each handler reads
// the rows it changes once, updates them, and writes them back once.
//
// A round entrant is a wallet like any pool bettor, so the shared rows (Wallet, DailyStats, GlobalStats.wallets and the
// growth chart) count a person once whichever product they used (Joshua, 2026-10-06). Every round is opened by one of
// Mako Market's own creator wallets, so the round counts are public figures; entries, stakes and claims by Mako
// Market's own wallets (src/internal-wallets.ts) are left out of the public totals as for pools.

import { indexer, type Round } from 'envio';

import { refundReasonOf, roundOutcomeOf, roundSideOf } from '../totals';
import { loadDay, loadGlobal, loadWallet, markActive, stamp, type HandlerContext } from './common';

async function getRound(context: HandlerContext, id: string, event: string, tx: string): Promise<Round> {
  const round = await context.Round.get(id);
  if (!round) throw new Error(`${event} for unknown round ${id} (tx ${tx})`);
  return round;
}

indexer.onEvent({ contract: 'MakoRoundsV1', event: 'RoundScheduled' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const p = event.params;
  context.Round.set({
    id: p.roundId.toString(),
    creator: p.creator.toLowerCase(),
    openTime: p.openTime,
    startTime: p.startTime,
    entryCloseTime: p.entryCloseTime,
    closeTime: p.closeTime,
    submitDeadline: p.submitDeadline,
    createdAt: ts,
    createdTx: event.transaction.hash,
    upPool: 0n,
    downPool: 0n,
    upEntrants: 0,
    downEntrants: 0,
    entryCount: 0,
    status: 'Active',
    refundReason: undefined,
    anchorPrice: undefined,
    closePrice: undefined,
    settledAt: undefined,
    settledTx: undefined,
    protocolFee: 0n,
    creatorFee: 0n,
    distributable: 0n,
    claimedTotal: 0n,
    remainderSwept: 0n,
  });
  const global = await loadGlobal(context);
  context.GlobalStats.set(stamp({ ...global, rounds: global.rounds + 1 }, ts, event.block.number));
});

indexer.onEvent({ contract: 'MakoRoundsV1', event: 'Entered' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const roundId = event.params.roundId.toString();
  const { amount, stakeTotal } = event.params;
  const side = roundSideOf(event.params.side);
  const round = await getRound(context, roundId, 'Entered', event.transaction.hash);

  let global = await loadGlobal(context);
  let day = await loadDay(context, ts, global);
  const loaded = await loadWallet(context, event.params.entrant, ts, global, day);
  let wallet = loaded.wallet;
  global = loaded.global;
  day = loaded.day;

  // The contract holds one stake per wallet per round, on one side, and emits the stake's new total: the first entry
  // is the one whose total equals its amount. A top-up adds money, not an entrant.
  const first = stakeTotal === amount;
  const up = side === 'Up';
  context.Round.set({
    ...round,
    upPool: up ? round.upPool + amount : round.upPool,
    downPool: up ? round.downPool : round.downPool + amount,
    upEntrants: round.upEntrants + (up && first ? 1 : 0),
    downEntrants: round.downEntrants + (!up && first ? 1 : 0),
    entryCount: round.entryCount + 1,
  });
  context.RoundEntry.set({
    id: `${event.block.number}_${event.logIndex}`,
    round_id: roundId,
    wallet_id: wallet.id,
    side,
    amount,
    timestamp: ts,
    txHash: event.transaction.hash,
    internal: wallet.internal,
  });

  wallet = {
    ...wallet,
    roundEntryCount: wallet.roundEntryCount + 1,
    roundsEntered: wallet.roundsEntered + (first ? 1 : 0),
    roundStaked: wallet.roundStaked + amount,
    net: wallet.net - amount,
    lastActiveAt: ts,
  };
  if (!wallet.internal) {
    global = {
      ...global,
      roundEntrants: global.roundEntrants + (wallet.roundEntryCount === 1 ? 1 : 0),
      roundEntries: global.roundEntries + 1,
      roundVolume: global.roundVolume + amount,
    };
    day = { ...day, roundEntries: day.roundEntries + 1, roundVolume: day.roundVolume + amount };
    day = await markActive(context, wallet, day);
  }

  context.Wallet.set(wallet);
  context.DailyStats.set(day);
  context.GlobalStats.set(stamp(global, ts, event.block.number));
});

indexer.onEvent({ contract: 'MakoRoundsV1', event: 'FeesAccrued' }, async ({ event, context }) => {
  const roundId = event.params.roundId.toString();
  const round = await getRound(context, roundId, 'FeesAccrued', event.transaction.hash);
  const { protocolFee, creatorFee, distributable } = event.params;
  context.Round.set({ ...round, protocolFee, creatorFee, distributable });
  const global = await loadGlobal(context);
  context.GlobalStats.set(stamp(global, event.block.timestamp, event.block.number));
});

indexer.onEvent({ contract: 'MakoRoundsV1', event: 'RoundSettled' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const roundId = event.params.roundId.toString();
  const round = await getRound(context, roundId, 'RoundSettled', event.transaction.hash);
  const outcome = roundOutcomeOf(event.params.outcome);
  context.Round.set({
    ...round,
    status: outcome,
    anchorPrice: event.params.anchorPrice,
    closePrice: event.params.closePrice,
    settledAt: ts,
    settledTx: event.transaction.hash,
  });
  // A round reaches one terminal state once (the contract refuses a second): counted only on leaving Active, so a
  // replayed or duplicated event cannot count it twice.
  const global = await loadGlobal(context);
  const counted = round.status === 'Active' ? 1 : 0;
  context.GlobalStats.set(
    stamp(
      {
        ...global,
        roundsUp: global.roundsUp + (outcome === 'Up' ? counted : 0),
        roundsDown: global.roundsDown + (outcome === 'Down' ? counted : 0),
      },
      ts,
      event.block.number,
    ),
  );
});

// A tie carries its settlement evidence in RoundTied and is then refunded by RoundRefunded(Tie) in the same
// transaction: the prices are recorded here, the status and the count move in RoundRefunded.
indexer.onEvent({ contract: 'MakoRoundsV1', event: 'RoundTied' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const roundId = event.params.roundId.toString();
  const round = await getRound(context, roundId, 'RoundTied', event.transaction.hash);
  context.Round.set({
    ...round,
    anchorPrice: event.params.anchorPrice,
    closePrice: event.params.closePrice,
    settledAt: ts,
    settledTx: event.transaction.hash,
  });
  const global = await loadGlobal(context);
  context.GlobalStats.set(stamp(global, ts, event.block.number));
});

indexer.onEvent({ contract: 'MakoRoundsV1', event: 'RoundRefunded' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const roundId = event.params.roundId.toString();
  const round = await getRound(context, roundId, 'RoundRefunded', event.transaction.hash);
  const reason = refundReasonOf(event.params.reason);
  context.Round.set({ ...round, status: 'Refunded', refundReason: reason, settledAt: round.settledAt ?? ts, settledTx: round.settledTx ?? event.transaction.hash });
  const global = await loadGlobal(context);
  const counted = round.status === 'Active' ? 1 : 0;
  context.GlobalStats.set(
    stamp(
      {
        ...global,
        roundsRefunded: global.roundsRefunded + counted,
        roundsTied: global.roundsTied + (reason === 'Tie' ? counted : 0),
        roundsOneSided: global.roundsOneSided + (reason === 'OneSided' ? counted : 0),
        roundsNoPrice: global.roundsNoPrice + (reason === 'NoPrice' ? counted : 0),
      },
      ts,
      event.block.number,
    ),
  );
});

indexer.onEvent({ contract: 'MakoRoundsV1', event: 'Claimed' }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const roundId = event.params.roundId.toString();
  const { stakePart, creatorFeePart } = event.params;
  const round = await getRound(context, roundId, 'Claimed', event.transaction.hash);

  let global = await loadGlobal(context);
  let day = await loadDay(context, ts, global);
  const loaded = await loadWallet(context, event.params.who, ts, global, day);
  let wallet = loaded.wallet;
  global = loaded.global;
  day = loaded.day;

  context.Round.set({ ...round, claimedTotal: round.claimedTotal + stakePart });
  context.RoundClaim.set({
    id: `${event.block.number}_${event.logIndex}`,
    round_id: roundId,
    wallet_id: wallet.id,
    stakePart,
    creatorFeePart,
    timestamp: ts,
    txHash: event.transaction.hash,
    internal: wallet.internal,
  });

  wallet = {
    ...wallet,
    roundClaimed: wallet.roundClaimed + stakePart,
    roundCreatorFees: wallet.roundCreatorFees + creatorFeePart,
    net: wallet.net + stakePart + creatorFeePart,
    lastActiveAt: ts,
  };
  if (!wallet.internal) {
    global = { ...global, roundClaims: global.roundClaims + 1, roundClaimed: global.roundClaimed + stakePart };
    day = await markActive(context, wallet, day);
  }

  context.Wallet.set(wallet);
  context.DailyStats.set(day);
  context.GlobalStats.set(stamp(global, ts, event.block.number));
});

indexer.onEvent({ contract: 'MakoRoundsV1', event: 'RemainderSwept' }, async ({ event, context }) => {
  const roundId = event.params.roundId.toString();
  const round = await getRound(context, roundId, 'RemainderSwept', event.transaction.hash);
  context.Round.set({ ...round, remainderSwept: round.remainderSwept + event.params.amount });
  const global = await loadGlobal(context);
  context.GlobalStats.set(stamp(global, event.block.timestamp, event.block.number));
});
