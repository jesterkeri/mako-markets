// The pool page (9a): the resolve rules the page states, the header clock and steps, why a bet is blocked, what
// the confirm sheet says for each outcome, and the exact sponsor requests the page sends.

import { describe, expect, it } from 'vitest';
import { maxUint256, stringToHex, type Hex } from 'viem';

import { buildBetBody, buildClaimBody, type RunOutcome } from '../aa-client';
import { assertBetBatchedCalls, assertBetSingleCall, assertClaimCall } from '../aa-call-allowlist';
import { MONAD_TESTNET_ID } from '../chain';
import { phaseFromOutcome, refusalPhase } from '../confirm-outcome';
import { MAKO_ADDRESS, MarketType, Outcome, type MarketWithId } from '../contract';
import { betBlocker, parseAmount, type BetLimits } from '../pool-bet-rules';
import { usdcExact } from '../pool-list';
import { parseOracleRef, poolClock, poolRules, poolSteps, RESOLUTION_GRACE_SEC } from '../pool-rules';
import { USDC_ADDRESS } from '../usdc';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;
const HOUR = 3_600;
const ref = (s: string) => stringToHex(s, { size: 32 });

function pool(over: Partial<MarketWithId>): MarketWithId {
  return {
    id: 7n,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: ref('BTC:gt:80000'),
    question: 'Will BTC close above $80,000 in 1 day?',
    createdAt: BigInt(NOW - HOUR),
    closeTime: BigInt(NOW + 3 * HOUR),
    bettingCloseTime: BigInt(NOW + 2 * HOUR),
    totalYes: 10n * USDC,
    totalNo: 10n * USDC,
    yesBettorCount: 1,
    noBettorCount: 1,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}
const rule = (m: MarketWithId, k: string) => poolRules(m, 'UTC').find((l) => l.k === k)?.v;

describe('parseOracleRef mirrors the resolver', () => {
  it('reads price, football and basketball references', () => {
    expect(parseOracleRef(pool({}))).toEqual({ kind: 'price', symbol: 'BTC', op: 'gt', strike: '80000' });
    expect(parseOracleRef(pool({ mType: MarketType.FOOTBALL, oracleRef: ref('537890:home_win:0') }))).toEqual({ kind: 'football', type: 'home_win', param: '0' });
    expect(parseOracleRef(pool({ mType: MarketType.BASKETBALL, oracleRef: ref('18444:over:220.5') }))).toEqual({ kind: 'basketball', type: 'over', param: '220.5' });
  });

  it('refuses what the resolver would skip', () => {
    expect(parseOracleRef(pool({ oracleRef: ref('BTC:eq:80000') }))).toBeNull();
    expect(parseOracleRef(pool({ mType: MarketType.BASKETBALL, oracleRef: ref('18444:draw:0') }))).toBeNull();
    expect(parseOracleRef(pool({ mType: MarketType.FOOTBALL, oracleRef: ref('abc:home_win:0') }))).toBeNull();
  });
});

describe('poolRules', () => {
  it('states the price rule with the strict comparison the resolver uses', () => {
    const m = pool({});
    expect(rule(m, 'YES')).toBe('BTC is above $80000 at the first price check after Fri 11:00.');
    expect(rule(m, 'NO')).toBe('BTC is at $80000 or below at that check.');
    expect(rule(m, 'SOURCE')).toBe('The CoinGecko spot price in USD, checked every minute.');
    expect(rule(pool({ oracleRef: ref('BTC:lt:80000') }), 'NO')).toBe('BTC is at $80000 or above at that check.');
  });

  it('writes forex strikes without a dollar sign and names Pyth for non-crypto prices', () => {
    const m = pool({ mType: MarketType.FOREX, oracleRef: ref('EURUSD:gt:1.095') });
    expect(rule(m, 'YES')).toBe('EURUSD is above 1.095 at the first price check after Fri 11:00.');
    expect(rule(m, 'SOURCE')).toContain('Pyth');
  });

  it('counts a draw as NO for a football home win, and refunds a postponed match', () => {
    const m = pool({ mType: MarketType.FOOTBALL, oracleRef: ref('537890:home_win:0') });
    expect(rule(m, 'NO')).toBe('A draw or an away win.');
    expect(rule(m, 'REFUND')).toMatch(/^A postponed or cancelled match is refunded\./);
    expect(rule(m, 'SOURCE')).toBe('The final result from football-data.org, at full time.');
  });

  it('refunds a basketball tie only for win questions', () => {
    expect(rule(pool({ mType: MarketType.BASKETBALL, oracleRef: ref('18444:home_win:0') }), 'REFUND')).toMatch(/and so is a tie\./);
    expect(rule(pool({ mType: MarketType.BASKETBALL, oracleRef: ref('18444:over:220.5') }), 'REFUND')).not.toMatch(/tie/);
  });

  it('states the 24H refund from the close time, and no YES/NO rule for an unreadable reference', () => {
    const m = pool({ oracleRef: ref('garbage') });
    expect(rule(m, 'YES')).toBeUndefined();
    expect(rule(m, 'REFUND')).toBe("If it isn't settled within 24H of Fri 11:00, anyone can mark it refunded. Refunds carry no fee: everyone claims their stake back.");
  });

  it('says a house pool is settled by hand', () => {
    expect(rule(pool({ mType: MarketType.MAKO }), 'SOURCE')).toBe('Mako Market.');
  });
});

describe('poolClock and poolSteps', () => {
  it('counts down to betting close, then to the close time, then flags an overdue result', () => {
    const m = pool({});
    expect(poolClock(m, 'open', NOW, 'UTC')).toMatchObject({ label: 'Closes in', value: '2H 0M' });
    expect(poolClock(m, 'betting_closed', NOW + 2 * HOUR, 'UTC')).toMatchObject({ label: 'Result after', value: '1H 0M' });
    expect(poolClock(m, 'resolving', NOW + 3 * HOUR, 'UTC').value).toBe('Settling');
    expect(poolClock(m, 'resolving', NOW + 3 * HOUR + RESOLUTION_GRACE_SEC, 'UTC').value).toBe('Overdue');
  });

  it('marks the current step per state', () => {
    const current = (s: Parameters<typeof poolSteps>[1]) => poolSteps(pool({}), s, 'UTC').findIndex((x) => x.current);
    expect([current('open'), current('betting_closed'), current('resolving'), current('yes_won')]).toEqual([0, 1, 2, 3]);
  });
});

describe('betBlocker follows placeBet, in its order', () => {
  const limits: BetLimits = { blocked: false, lastBetTime: 0, maxPerWallet: 10_000n * USDC, maxShareBps: 2_000, shareCapMinPool: 200n * USDC };
  const base = { m: pool({}), nowSec: NOW, amount: USDC, balance: 100n * USDC, mine: { yes: 0n, no: 0n }, limits };

  it('passes a normal bet', () => expect(betBlocker(base)).toBeNull());
  it('closes at the betting close second itself', () => {
    expect(betBlocker({ ...base, nowSec: NOW + 2 * HOUR })).toBe('Betting has closed on this pool.');
  });
  it('holds the 0.10 USDC minimum exactly', () => {
    expect(betBlocker({ ...base, amount: 99_999n })).toBe('The minimum bet is 0.10 USDC.');
    expect(betBlocker({ ...base, amount: 100_000n })).toBeNull();
  });
  it('waits 30 seconds between bets on the same pool', () => {
    expect(betBlocker({ ...base, limits: { ...limits, lastBetTime: NOW - 29 } })).toBe('One bet per pool every 30 seconds. Try again in 1s.');
    expect(betBlocker({ ...base, limits: { ...limits, lastBetTime: NOW - 30 } })).toBeNull();
  });
  it('applies the per-wallet cap to both sides together', () => {
    const tight = { ...limits, maxPerWallet: 5n * USDC };
    expect(betBlocker({ ...base, mine: { yes: 3n * USDC, no: USDC }, amount: USDC, limits: tight })).toBeNull();
    expect(betBlocker({ ...base, mine: { yes: 3n * USDC, no: USDC }, amount: USDC + 1n, limits: tight })).toMatch(/^One wallet can put at most 5.00 USDC/);
  });
  it('applies the 20% share cap only once the pool after the bet reaches the threshold', () => {
    const big = pool({ totalYes: 150n * USDC, totalNo: 40n * USDC });
    // 190 + 10 = 200 >= 200, and 10 / 200 = 5%: allowed. 190 + 50 = 240, 50 / 240 = 20.8%: refused.
    expect(betBlocker({ ...base, m: big, amount: 10n * USDC })).toBeNull();
    expect(betBlocker({ ...base, m: big, amount: 50n * USDC })).toMatch(/at most 20% of it/);
    // Below the threshold the same share is fine: 100 + 50 = 150 < 200.
    expect(betBlocker({ ...base, m: pool({ totalYes: 50n * USDC, totalNo: 50n * USDC }), amount: 50n * USDC })).toBeNull();
  });
  it('checks the balance last', () => {
    expect(betBlocker({ ...base, amount: 101n * USDC })).toBe('Not enough USDC. Your balance is 100.00.');
  });
  it('parses amounts to base units and refuses anything else', () => {
    expect(['5', '5.5', '0.10', '1.123456'].map(parseAmount)).toEqual([5n * USDC, 5_500_000n, 100_000n, 1_123_456n]);
    expect(['', '-1', '1.1234567', 'abc', '1e3'].map(parseAmount)).toEqual([null, null, null, null, null]);
  });
});

describe('usdcExact', () => {
  it('shows a confirmed amount exactly, never rounded', () => {
    expect(usdcExact(2_000_000n)).toBe('2.00');
    expect(usdcExact(1_999_999n)).toBe('1.999999');
    expect(usdcExact(1_250_500_000n)).toBe('1,250.50');
    expect(usdcExact(100_000n)).toBe('0.10');
    expect(usdcExact(1n)).toBe('0.000001');
    expect(usdcExact(0n)).toBe('0.00');
  });
});

describe('phaseFromOutcome', () => {
  const w = { noun: 'bet', failTitle: "Bet didn't go through" };
  const id = '00000000-0000-0000-0000-000000000001';
  const tx = ('0x' + 'ab'.repeat(32)) as Hex;
  const phase = (o: RunOutcome) => phaseFromOutcome(o, w);

  it('is done only when the transaction landed', () => {
    expect(phase({ kind: 'sent', pendingUserOpId: id, txHash: tx, userOpHash: tx })).toEqual({ step: 'done', txHash: tx });
  });

  it('says nothing moved only when the flow knows it', () => {
    const moved = (o: RunOutcome) => {
      const p = phase(o);
      return p.step === 'failed' ? p.nothingMoved : p.step;
    };
    expect(moved({ kind: 'reverted', pendingUserOpId: id, txHash: tx, userOpHash: tx, failureReason: 'x' })).toBe(true);
    expect(moved({ kind: 'failed_pre_submit', pendingUserOpId: id, failureReason: 'x' })).toBe(true);
    expect(moved({ kind: 'expired', pendingUserOpId: id })).toBe(true);
    expect(moved({ kind: 'sponsor_failed', status: 429, error: 'CAP_EXCEEDED' })).toBe(true);
    expect(moved({ kind: 'send_failed', status: 403, error: 'signer_mismatch' })).toBe(true);
    // Unknown outcomes never claim nothing moved.
    expect(moved({ kind: 'submitted', pendingUserOpId: id, userOpHash: tx })).toBe(false);
    expect(moved({ kind: 'in_progress', pendingUserOpId: id, retryAfterSeconds: 2 })).toBe(false);
    expect(moved({ kind: 'manual_review', pendingUserOpId: id })).toBe(false);
    expect(moved({ kind: 'send_failed', status: 0, error: 'send_transport_failed' })).toBe(false);
    expect(moved({ kind: 'send_failed', status: 500, error: 'INTERNAL' })).toBe(false);
  });

  it('treats a refused signature as the user cancelling', () => {
    expect(phase({ kind: 'send_failed', status: 0, error: 'sign_rejected' })).toEqual({ step: 'cancelled' });
  });

  it('names the daily gas-free limit', () => {
    const p = phase({ kind: 'sponsor_failed', status: 429, error: 'CAP_EXCEEDED' });
    expect(p.step === 'failed' && p.body).toBe('An email account gets 10 gas-free transactions a day. Try again tomorrow.');
  });

  it('names why the gas sponsor refused a new pool, and keeps the generic wording otherwise', () => {
    const cw = { noun: 'pool', failTitle: "The pool wasn't created", afterRevert: 'Check the times and try again.' };
    const refused = (reason: string) => phaseFromOutcome({ kind: 'sponsor_failed', status: 403, error: 'NOT_ALLOWED', reason }, cw);
    expect(refused('bad_create_daily_cap_exceeded')).toMatchObject({ title: 'Daily limit reached', nothingMoved: true });
    expect(refused('bad_create_timestamps')).toMatchObject({ title: 'Times no longer fit' });
    expect(refused('bad_create_seed_too_small')).toMatchObject({ title: 'First bet too small' });
    expect(refused('bad_create_args')).toMatchObject({ title: "The pool wasn't created", body: "Mako Market can't cover the gas for this pool." });
    expect(phaseFromOutcome({ kind: 'reverted', pendingUserOpId: id, txHash: tx, userOpHash: tx, failureReason: 'x' }, cw)).toMatchObject({
      body: 'Monad turned the pool down, so it was undone. Check the times and try again.',
    });
    expect(refusalPhase('CreatorDailyCapExceeded', cw)).toMatchObject({ title: 'Daily limit reached', nothingMoved: true });
  });

  it('explains a contract refusal found before sending', () => {
    const p = refusalPhase('BetTooSoon', w);
    expect(p).toMatchObject({ step: 'failed', title: 'Too soon', nothingMoved: true });
    expect(refusalPhase('SomethingNew', w)).toMatchObject({ title: "Bet didn't go through", body: 'Monad would turn the bet down (SomethingNew).' });
  });
});

describe('sponsor requests pass the server allowlist unchanged', () => {
  const SAFE = '0x00000000000000000000000000000000000005af' as const;
  const toCall = (c: { to: `0x${string}`; value: Hex; data: Hex }) => ({ to: c.to, value: BigInt(c.value), data: c.data });
  const args = { chainId: MONAD_TESTNET_ID, marketId: 7n, isYes: false, amountUsdc: 5n * USDC, usdcAddress: USDC_ADDRESS, makoAddress: MAKO_ADDRESS };

  it('sends placeBet alone when the allowance covers the stake', () => {
    const body = buildBetBody({ ...args, currentAllowance: 5n * USDC });
    expect(body.kind).toBe('bet_single');
    if (body.kind !== 'bet_single') throw new Error('shape');
    expect(() => assertBetSingleCall({ chainId: body.chainId, safeAddress: SAFE, call: toCall(body.call) })).not.toThrow();
  });

  it('batches approve(MAKO, MaxUint256) first when the allowance is short by one unit', () => {
    const body = buildBetBody({ ...args, currentAllowance: 5n * USDC - 1n });
    expect(body.kind).toBe('bet_batched');
    if (body.kind !== 'bet_batched') throw new Error('shape');
    expect(body.calls[0].to).toBe(USDC_ADDRESS);
    expect(body.calls[0].data.endsWith(maxUint256.toString(16))).toBe(true);
    expect(() => assertBetBatchedCalls({ chainId: body.chainId, safeAddress: SAFE, calls: [toCall(body.calls[0]), toCall(body.calls[1])] })).not.toThrow();
  });

  it('claims on the Pools contract', () => {
    const body = buildClaimBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 7n });
    if (body.kind !== 'claim') throw new Error('shape');
    expect(() => assertClaimCall({ chainId: body.chainId, safeAddress: SAFE, call: toCall(body.call) })).not.toThrow();
  });
});
