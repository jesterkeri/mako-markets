import { describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  encodeErrorResult,
  type Hex,
} from 'viem';
import { makoAbi } from '../src/abi';
import {
  MAKO_MARKET_TYPE,
  MAX_BROADCASTS_PER_TICK,
  OUTCOME_REFUND,
  RESOLUTION_GRACE_SEC,
  classifySendError,
  decideAction,
  isHeldTwoSided,
  isOneSided,
  newKeeperTick,
  refundDeadline,
  revertErrorName,
  runNoDataAction,
  txFor,
  type DecideOptions,
  type FinalizedRead,
  type KeeperIo,
  type NoDataTx,
  type Receipt,
  type SettlementView,
} from '../src/settlement';

// Market types, MakoMarketsV4.sol:60-68.
const FOOTBALL = 0;
const CRYPTO = 1;
const BASKETBALL = 2;
const FOREX = 3;
const COMMODITIES = 4;
const STOCKS = 5;
const NON_MAKO = [FOOTBALL, CRYPTO, BASKETBALL, FOREX, COMMODITIES, STOCKS] as const;

const USDC = 1_000_000n;
const CLOSE = 1_790_800_396n; // market #92's real closeTime (2026-09-30 20:33:16 UTC)
const DEADLINE = CLOSE + 86_400n;
const OFF: DecideOptions = { forceRefundTwoSided: false };
const ON: DecideOptions = { forceRefundTwoSided: true };

function mk(over: Partial<SettlementView> = {}): SettlementView {
  return { mType: CRYPTO, closeTime: CLOSE, totalYes: USDC, totalNo: 0n, resolved: false, ...over };
}
const yesOnly = (o: Partial<SettlementView> = {}) => mk({ totalYes: USDC, totalNo: 0n, ...o });
const noOnly = (o: Partial<SettlementView> = {}) => mk({ totalYes: 0n, totalNo: USDC, ...o });
const twoSided = (o: Partial<SettlementView> = {}) => mk({ totalYes: USDC, totalNo: 3n * USDC, ...o });

describe('contract constants', () => {
  it('pins the V4 values the keeper depends on', () => {
    expect(RESOLUTION_GRACE_SEC).toBe(86_400n); // RESOLUTION_GRACE = 24 hours, L138; 86400 read on chain
    expect(OUTCOME_REFUND).toBe(3); // Outcome.REFUND, L73
    expect(MAKO_MARKET_TYPE).toBe(6); // MarketType.MAKO, L67
    expect(refundDeadline(CLOSE)).toBe(DEADLINE);
  });

  it('the ABI the worker signs with has the functions and errors used here', () => {
    const names = (makoAbi as Array<{ type: string; name?: string }>)
      .filter((x) => x.type === 'function' || x.type === 'error')
      .map((x) => `${x.type}:${x.name}`);
    for (const n of [
      'function:resolveMarket',
      'function:forceRefund',
      'function:getMarket',
      'error:AlreadyResolved',
      'error:StillInGrace',
      'error:MarketNotClosed',
    ]) {
      expect(names).toContain(n);
    }
  });
});

describe('isOneSided', () => {
  it('matches the contract test minSide == 0, both-zero included', () => {
    expect(isOneSided({ totalYes: USDC, totalNo: 0n })).toBe(true);
    expect(isOneSided({ totalYes: 0n, totalNo: USDC })).toBe(true);
    expect(isOneSided({ totalYes: 0n, totalNo: 0n })).toBe(true);
    expect(isOneSided({ totalYes: 1n, totalNo: 1n })).toBe(false);
  });
});

describe('decideAction', () => {
  describe('one-sided pools past close need no data', () => {
    for (const t of NON_MAKO) {
      it(`type ${t}: YES-only past close -> resolve_one_sided`, () => {
        expect(decideAction(yesOnly({ mType: t }), CLOSE + 60n, OFF)).toBe('resolve_one_sided');
      });
      it(`type ${t}: NO-only past close -> resolve_one_sided`, () => {
        expect(decideAction(noOnly({ mType: t }), CLOSE + 60n, OFF)).toBe('resolve_one_sided');
      });
    }
    it('settles at the close second itself (contract reverts only while now < closeTime)', () => {
      expect(decideAction(yesOnly(), CLOSE, OFF)).toBe('resolve_one_sided');
    });
    it('the two-sided switch does not change one-sided handling before the deadline', () => {
      expect(decideAction(yesOnly(), CLOSE + 60n, ON)).toBe('resolve_one_sided');
    });
  });

  describe('two-sided pools keep the normal price/result path', () => {
    for (const t of NON_MAKO) {
      it(`type ${t}: two-sided past close -> fetch_and_resolve`, () => {
        expect(decideAction(twoSided({ mType: t }), CLOSE + 60n, OFF)).toBe('fetch_and_resolve');
      });
    }
    it('even with the two-sided switch on, before the deadline', () => {
      expect(decideAction(twoSided(), DEADLINE - 1n, ON)).toBe('fetch_and_resolve');
    });
  });

  describe('not yet closed', () => {
    it('one second before close -> skip, for every shape', () => {
      for (const m of [yesOnly(), noOnly(), twoSided(), mk({ mType: MAKO_MARKET_TYPE })]) {
        expect(decideAction(m, CLOSE - 1n, OFF)).toBe('skip');
        expect(decideAction(m, CLOSE - 1n, ON)).toBe('skip');
      }
    });
    it('long before close -> skip', () => {
      expect(decideAction(yesOnly(), CLOSE - 7n * 86_400n, OFF)).toBe('skip');
    });
  });

  describe('MAKO (hand-resolved)', () => {
    const mako = (o: Partial<SettlementView>) => mk({ mType: MAKO_MARKET_TYPE, ...o });
    it('is never resolved by the worker before the deadline, one-sided or not', () => {
      for (const m of [mako({ totalYes: USDC, totalNo: 0n }), mako({ totalYes: 0n, totalNo: 0n }), mako({ totalYes: USDC, totalNo: USDC })]) {
        expect(decideAction(m, CLOSE + 60n, OFF)).toBe('skip');
        expect(decideAction(m, DEADLINE - 1n, OFF)).toBe('skip');
        expect(decideAction(m, DEADLINE - 1n, ON)).toBe('skip');
      }
    });
    it('one-sided (or empty) MAKO pool at the deadline -> force_refund (REFUND on every path)', () => {
      expect(decideAction(mako({ totalYes: USDC, totalNo: 0n }), DEADLINE, OFF)).toBe('force_refund');
      expect(decideAction(mako({ totalYes: 0n, totalNo: 0n }), DEADLINE, OFF)).toBe('force_refund');
    });
    it('two-sided MAKO pool at the deadline is held unless the switch is on', () => {
      expect(decideAction(mako({ totalYes: USDC, totalNo: USDC }), DEADLINE, OFF)).toBe('skip');
      expect(decideAction(mako({ totalYes: USDC, totalNo: USDC }), DEADLINE, ON)).toBe('force_refund');
    });
  });

  describe('the 24h refund deadline', () => {
    it('one-sided: one second before -> resolve_one_sided, exactly at -> force_refund', () => {
      expect(decideAction(yesOnly(), DEADLINE - 1n, OFF)).toBe('resolve_one_sided');
      expect(decideAction(yesOnly(), DEADLINE, OFF)).toBe('force_refund');
      expect(decideAction(noOnly(), DEADLINE - 1n, OFF)).toBe('resolve_one_sided');
      expect(decideAction(noOnly(), DEADLINE, OFF)).toBe('force_refund');
      expect(decideAction(yesOnly(), DEADLINE + 3n * 86_400n, OFF)).toBe('force_refund');
    });
    it('two-sided, switch off: stays on fetch_and_resolve at and after the deadline', () => {
      expect(decideAction(twoSided(), DEADLINE - 1n, OFF)).toBe('fetch_and_resolve');
      expect(decideAction(twoSided(), DEADLINE, OFF)).toBe('fetch_and_resolve');
    });
    it('two-sided, switch on: one second before -> fetch_and_resolve, exactly at -> force_refund', () => {
      expect(decideAction(twoSided(), DEADLINE - 1n, ON)).toBe('fetch_and_resolve');
      expect(decideAction(twoSided(), DEADLINE, ON)).toBe('force_refund');
    });
    it('every type goes to force_refund at the deadline when one-sided', () => {
      for (const t of [...NON_MAKO, MAKO_MARKET_TYPE]) {
        expect(decideAction(yesOnly({ mType: t }), DEADLINE, OFF)).toBe('force_refund');
      }
    });
  });

  describe('already resolved', () => {
    it('is always skip, whatever the time, shape, type or switch', () => {
      for (const t of [...NON_MAKO, MAKO_MARKET_TYPE]) {
        for (const shape of [yesOnly, noOnly, twoSided]) {
          for (const now of [CLOSE - 1n, CLOSE, CLOSE + 60n, DEADLINE - 1n, DEADLINE, DEADLINE + 86_400n]) {
            expect(decideAction(shape({ mType: t, resolved: true }), now, OFF)).toBe('skip');
            expect(decideAction(shape({ mType: t, resolved: true }), now, ON)).toBe('skip');
          }
        }
      }
    });
  });
});

describe('isHeldTwoSided', () => {
  it('counts only unresolved two-sided pools at or past the deadline with the switch off', () => {
    expect(isHeldTwoSided(twoSided(), DEADLINE, OFF)).toBe(true);
    expect(isHeldTwoSided(twoSided(), DEADLINE - 1n, OFF)).toBe(false);
    expect(isHeldTwoSided(twoSided(), DEADLINE, ON)).toBe(false);
    expect(isHeldTwoSided(twoSided({ resolved: true }), DEADLINE, OFF)).toBe(false);
    expect(isHeldTwoSided(yesOnly(), DEADLINE, OFF)).toBe(false);
  });
});

describe('txFor', () => {
  it('one-sided settles with resolveMarket(id, REFUND=3)', () => {
    expect(txFor('resolve_one_sided', 92n)).toEqual({ functionName: 'resolveMarket', args: [92n, 3] });
  });
  it('the keeper sends forceRefund(id)', () => {
    expect(txFor('force_refund', 88n)).toEqual({ functionName: 'forceRefund', args: [88n] });
  });
});

// ---------------------------------------------------------------------------
// Error classification, on the error objects viem really builds. The shape
// below is what viem's getContractError produces for a decoded custom-error
// revert, and matches what a read-only estimateGas against Monad testnet
// returned for forceRefund(87) / forceRefund(92) on 2026-09-30.
// ---------------------------------------------------------------------------

function revertOf(functionName: 'forceRefund' | 'resolveMarket', errorName: string, args: unknown[]) {
  const data = encodeErrorResult({ abi: makoAbi as never, errorName } as never);
  const reverted = new ContractFunctionRevertedError({ abi: makoAbi as never, data, functionName });
  return new ContractFunctionExecutionError(reverted, {
    abi: makoAbi as never,
    args,
    contractAddress: '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
    functionName,
  });
}

describe('classifySendError', () => {
  it('reads the decoded custom-error name that the short message hides', () => {
    const e = revertOf('forceRefund', 'AlreadyResolved', [87n]);
    expect(e.shortMessage).toBe('The contract function "forceRefund" reverted.');
    expect(revertErrorName(e)).toBe('AlreadyResolved');
    expect(classifySendError(e)).toBe('already_resolved');
  });
  it('StillInGrace and MarketNotClosed mean "not yet", retry next tick', () => {
    expect(classifySendError(revertOf('forceRefund', 'StillInGrace', [92n]))).toBe('not_yet');
    expect(classifySendError(revertOf('resolveMarket', 'MarketNotClosed', [90n, 3]))).toBe('not_yet');
  });
  it('other reverts are "other"', () => {
    expect(classifySendError(revertOf('resolveMarket', 'NotResolver', [92n, 3]))).toBe('other');
  });
  it("viem's InsufficientFundsError is recognised through the wrapper", () => {
    const e = new ContractFunctionExecutionError(new InsufficientFundsError(), {
      abi: makoAbi as never,
      args: [88n],
      contractAddress: '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
      functionName: 'forceRefund',
    });
    expect(classifySendError(e)).toBe('insufficient_funds');
  });
  it('a raw node message about funds is recognised too', () => {
    expect(classifySendError(new Error('insufficient funds for gas * price + value'))).toBe('insufficient_funds');
  });
  it('unknown shapes are "other" and never throw', () => {
    for (const e of [new Error('boom'), 'string', null, undefined, 42, { cause: { cause: null } }]) {
      expect(classifySendError(e)).toBe('other');
    }
  });
  it('a cyclic cause chain terminates', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' };
    const b = { cause: a, message: 'b' };
    a.cause = b;
    expect(classifySendError(a)).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// runNoDataAction: re-read, idempotency, caps, dry run, error handling
// ---------------------------------------------------------------------------

type FakeOpts = {
  reads?: Array<FinalizedRead | Error>;
  sendResult?: Hex | Error;
  receipt?: Receipt | 'timeout' | Error;
  /// The resolver wallet's transaction count at latest / finalized (default 7 and 7).
  nonce?: { latest: number; finalized: number } | Error;
};

function fakeIo(o: FakeOpts = {}) {
  const sends: NoDataTx[] = [];
  const nonces: number[] = [];
  const reads: bigint[] = [];
  const lines: string[] = [];
  const queue = [...(o.reads ?? [])];
  const io: KeeperIo = {
    async readFinalized(id) {
      reads.push(id);
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next === undefined) throw new Error('no read scripted');
      if (next instanceof Error) throw next;
      return next;
    },
    async nonceAt(tag) {
      const n = o.nonce ?? { latest: 7, finalized: 7 };
      if (n instanceof Error) throw n;
      return n[tag];
    },
    async send(tx, nonce) {
      sends.push(tx);
      nonces.push(nonce);
      const r = o.sendResult ?? ('0xabc' as Hex);
      if (r instanceof Error) throw r;
      return r;
    },
    async waitForReceipt() {
      const r = o.receipt ?? { status: 'success', blockNumber: 123n };
      if (r instanceof Error) throw r;
      return r;
    },
    log: (l) => lines.push(l),
    warn: (l) => lines.push(l),
  };
  return { io, sends, nonces, reads, lines };
}

const at = (market: SettlementView, blockTimestamp: bigint, blockNumber = 1000n): FinalizedRead => ({
  market,
  blockNumber,
  blockTimestamp,
});

describe('runNoDataAction', () => {
  it('one-sided: re-reads at finalized, sends resolveMarket(id, REFUND) once, logs the receipt', async () => {
    const f = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('sent');
    expect(f.reads).toEqual([92n]);
    expect(f.sends).toEqual([{ functionName: 'resolveMarket', args: [92n, 3] }]);
    expect(f.lines.join('\n')).toMatch(/market 92: one-sided pool \(YES 1\.000000 USDC, NO 0\.000000 USDC\)/);
    expect(f.lines.join('\n')).toMatch(/market 92: RESOLVED REFUND \(one-sided\), block 123, tx 0xabc/);
  });

  it('keeper: sends forceRefund(id) once past the deadline', async () => {
    const f = fakeIo({ reads: [at(yesOnly({ mType: STOCKS }), DEADLINE + 10n)] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 88n, 'force_refund')).toBe('sent');
    expect(f.sends).toEqual([{ functionName: 'forceRefund', args: [88n] }]);
    expect(f.lines.join('\n')).toMatch(/market 88: FORCE-REFUNDED, block 123/);
  });

  it('never sends twice for one market in a tick', async () => {
    const f = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('sent');
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('duplicate');
    expect(await runNoDataAction(f.io, tick, 92n, 'force_refund')).toBe('duplicate');
    expect(f.sends).toHaveLength(1);
    expect(f.reads).toHaveLength(1);
  });

  it('a failed send still counts as attempted: no second attempt in the same tick', async () => {
    const f = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)], sendResult: new Error('rpc blip') });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('failed');
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('duplicate');
    expect(f.sends).toHaveLength(1);
  });

  it('does not send when the fresh read shows the market already resolved', async () => {
    const f = fakeIo({ reads: [at(yesOnly({ resolved: true }), DEADLINE + 10n)] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 88n, 'force_refund')).toBe('state_changed');
    expect(f.sends).toHaveLength(0);
    expect(tick.gate.broadcasts).toBe(0); // nothing broadcast
  });

  it('does not call a pool one-sided from a finalized block before close, whatever the worker clock said', async () => {
    // The scan (worker clock) said closed; the finalized block is still 2s
    // before close, when a last bet could still land.
    const f = fakeIo({ reads: [at(yesOnly(), CLOSE - 2n)] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('state_changed');
    expect(f.sends).toHaveLength(0);
  });

  it('does not send when a bet made the pool two-sided (fresh read disagrees)', async () => {
    const f = fakeIo({ reads: [at(twoSided(), CLOSE + 1n)] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('state_changed');
    expect(f.sends).toHaveLength(0);
  });

  it('does not forceRefund until the finalized block itself is past the deadline', async () => {
    const f = fakeIo({ reads: [at(yesOnly(), DEADLINE - 1n)] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'force_refund')).toBe('state_changed');
    expect(f.sends).toHaveLength(0);
  });

  it('does not forceRefund a two-sided pool with the switch off, even if asked', async () => {
    const f = fakeIo({ reads: [at(twoSided(), DEADLINE + 10n)] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 7n, 'force_refund')).toBe('state_changed');
    expect(f.sends).toHaveLength(0);
  });

  it('forceRefunds a two-sided pool at the deadline only with the switch on', async () => {
    const f = fakeIo({ reads: [at(twoSided(), DEADLINE)] });
    const tick = newKeeperTick('t', false, ON);
    expect(await runNoDataAction(f.io, tick, 7n, 'force_refund')).toBe('sent');
    expect(f.sends).toEqual([{ functionName: 'forceRefund', args: [7n] }]);
    expect(f.lines.join('\n')).toMatch(/two-sided/);
  });

  it('does not send when the re-read fails', async () => {
    const f = fakeIo({ reads: [new Error('429')] });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('reread_failed');
    expect(f.sends).toHaveLength(0);
  });

  it('dry run re-reads and logs but never sends', async () => {
    const f = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)] });
    const tick = newKeeperTick('t', true, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('dry_run');
    expect(f.sends).toHaveLength(0);
    expect(f.lines.join('\n')).toMatch(/\[DRY RUN, not written\]/);
  });

  it('broadcasts once per tick, whatever the action, and defers the rest without reading', async () => {
    const f = fakeIo({ reads: [at(yesOnly(), DEADLINE + 10n)] });
    const tick = newKeeperTick('t', false, OFF);
    const results = [];
    for (let id = 0n; id < 4n; id++) results.push(await runNoDataAction(f.io, tick, id, 'force_refund'));
    const f2 = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)] });
    results.push(await runNoDataAction(f2.io, tick, 100n, 'resolve_one_sided'));
    expect(MAX_BROADCASTS_PER_TICK).toBe(1);
    expect(results).toEqual(['sent', 'deferred', 'deferred', 'deferred', 'deferred']);
    expect(f.sends).toHaveLength(1);
    expect(f.reads).toHaveLength(1);
    expect(f2.reads).toHaveLength(0);
  });

  it('a send refused at gas estimation (AlreadyResolved) broadcast nothing, so the slot stays free', async () => {
    const tick = newKeeperTick('t', false, OFF);
    const a = fakeIo({ reads: [at(yesOnly(), DEADLINE + 10n)], sendResult: revertOf('forceRefund', 'AlreadyResolved', [1n]) });
    expect(await runNoDataAction(a.io, tick, 1n, 'force_refund')).toBe('already_resolved');
    const b = fakeIo({ reads: [at(yesOnly(), DEADLINE + 10n)] });
    expect(await runNoDataAction(b.io, tick, 2n, 'force_refund')).toBe('sent');
  });

  it('pins the nonce to the latest count, and sends nothing while a resolver transaction is not final', async () => {
    const ok = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)], nonce: { latest: 252, finalized: 252 } });
    expect(await runNoDataAction(ok.io, newKeeperTick('t', false, OFF), 92n, 'resolve_one_sided')).toBe('sent');
    expect(ok.nonces).toEqual([252]);
    const busy = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)], nonce: { latest: 253, finalized: 252 } });
    expect(await runNoDataAction(busy.io, newKeeperTick('t', false, OFF), 92n, 'resolve_one_sided')).toBe('deferred');
    expect(busy.sends).toHaveLength(0);
    expect(busy.lines.join('\n')).toMatch(/not final yet \(nonce 253 latest, 252 finalized\)/);
    const unreadable = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)], nonce: new Error('rpc down') });
    expect(await runNoDataAction(unreadable.io, newKeeperTick('t', false, OFF), 92n, 'resolve_one_sided')).toBe('failed');
    expect(unreadable.sends).toHaveLength(0);
  });

  it('a receipt timeout cannot be paid twice: the next tick re-sends at the SAME nonce (Codex r1 F2)', async () => {
    // Tick 1: broadcast at nonce 40, no receipt within the limit; the transaction sits in the mempool, so the
    // wallet's count is still 40 at latest and at finalized (Monad: pending = latest).
    const t1 = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)], sendResult: '0xaaa', receipt: 'timeout', nonce: { latest: 40, finalized: 40 } });
    expect(await runNoDataAction(t1.io, newKeeperTick('12:00:00', false, OFF), 92n, 'resolve_one_sided')).toBe('receipt_timeout');
    // Tick 2: a fresh Worker invocation with no memory. The market still reads unresolved, so it is sent again, at
    // the same nonce: the chain includes at most one transaction per nonce, so at most one is ever paid for.
    const t2 = fakeIo({ reads: [at(yesOnly(), CLOSE + 90n)], nonce: { latest: 40, finalized: 40 } });
    expect(await runNoDataAction(t2.io, newKeeperTick('12:01:00', false, OFF), 92n, 'resolve_one_sided')).toBe('sent');
    expect([...t1.nonces, ...t2.nonces]).toEqual([40, 40]);
    // Tick 2 again, but tick 1's transaction was included and is not final yet: nothing is sent at all.
    const t2b = fakeIo({ reads: [at(yesOnly(), CLOSE + 90n)], nonce: { latest: 41, finalized: 40 } });
    expect(await runNoDataAction(t2b.io, newKeeperTick('12:01:00', false, OFF), 92n, 'resolve_one_sided')).toBe('deferred');
    expect(t2b.sends).toHaveLength(0);
  });

  it('AlreadyResolved at send time: continue, no second attempt', async () => {
    const f = fakeIo({
      reads: [at(yesOnly(), DEADLINE + 10n)],
      sendResult: revertOf('forceRefund', 'AlreadyResolved', [88n]),
    });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 88n, 'force_refund')).toBe('already_resolved');
  });

  it('StillInGrace at send time: retry next tick', async () => {
    const f = fakeIo({
      reads: [at(yesOnly(), DEADLINE + 1n)],
      sendResult: revertOf('forceRefund', 'StillInGrace', [88n]),
    });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 88n, 'force_refund')).toBe('not_yet');
    expect(f.lines.join('\n')).toMatch(/StillInGrace/);
  });

  it('insufficient funds stops the tick (same rule as the resolveMarket path)', async () => {
    const e = new ContractFunctionExecutionError(new InsufficientFundsError(), {
      abi: makoAbi as never,
      args: [88n],
      contractAddress: '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
      functionName: 'forceRefund',
    });
    const f = fakeIo({ reads: [at(yesOnly(), DEADLINE + 10n)], sendResult: e });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 88n, 'force_refund')).toBe('out_of_funds');
    expect(f.lines.join('\n')).toMatch(/resolver wallet out of MON, stopping tick/);
  });

  it('a reverted receipt is reported, not counted as settled', async () => {
    const f = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)], receipt: { status: 'reverted', blockNumber: 9n } });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('reverted');
  });

  it('a receipt timeout logs the hash so the pending tx can be traced', async () => {
    const f = fakeIo({ reads: [at(yesOnly(), CLOSE + 30n)], sendResult: '0xfeed', receipt: 'timeout' });
    const tick = newKeeperTick('t', false, OFF);
    expect(await runNoDataAction(f.io, tick, 92n, 'resolve_one_sided')).toBe('receipt_timeout');
    expect(f.lines.join("\n")).toMatch(/tx 0xfeed \(nonce 7\) has no receipt yet/);
  });

  it('every log line is plain ASCII (no em-dashes)', async () => {
    const all: string[] = [];
    const scenarios: Array<[FakeOpts, 'resolve_one_sided' | 'force_refund', DecideOptions, boolean]> = [
      [{ reads: [at(yesOnly(), CLOSE + 30n)] }, 'resolve_one_sided', OFF, false],
      [{ reads: [at(yesOnly(), CLOSE + 30n)] }, 'resolve_one_sided', OFF, true],
      [{ reads: [at(twoSided(), DEADLINE)] }, 'force_refund', ON, false],
      [{ reads: [at(yesOnly({ resolved: true }), DEADLINE)] }, 'force_refund', OFF, false],
      [{ reads: [new Error('x')] }, 'force_refund', OFF, false],
      [{ reads: [at(yesOnly(), DEADLINE)], sendResult: revertOf('forceRefund', 'AlreadyResolved', [1n]) }, 'force_refund', OFF, false],
      [{ reads: [at(yesOnly(), DEADLINE)], sendResult: revertOf('forceRefund', 'StillInGrace', [1n]) }, 'force_refund', OFF, false],
      [{ reads: [at(yesOnly(), DEADLINE)], sendResult: new InsufficientFundsError() }, 'force_refund', OFF, false],
      [{ reads: [at(yesOnly(), DEADLINE)], sendResult: new Error('boom') }, 'force_refund', OFF, false],
      [{ reads: [at(yesOnly(), DEADLINE)], receipt: 'timeout' }, 'force_refund', OFF, false],
      [{ reads: [at(yesOnly(), DEADLINE)], receipt: new Error('rpc') }, 'force_refund', OFF, false],
      [{ reads: [at(yesOnly(), DEADLINE)], receipt: { status: 'reverted', blockNumber: 1n } }, 'force_refund', OFF, false],
    ];
    for (const [o, action, opts, dry] of scenarios) {
      const f = fakeIo(o);
      const tick = newKeeperTick('12:00:00', dry, opts);
      await runNoDataAction(f.io, tick, 5n, action);
      await runNoDataAction(f.io, tick, 5n, action); // duplicate line
      all.push(...f.lines);
    }
    const capped = newKeeperTick('12:00:00', false, OFF);
    capped.gate.broadcasts = MAX_BROADCASTS_PER_TICK;
    const fc = fakeIo({ reads: [at(yesOnly(), DEADLINE)] });
    await runNoDataAction(fc.io, capped, 6n, 'force_refund'); // deferred line
    all.push(...fc.lines);

    expect(all.length).toBeGreaterThan(20);
    for (const line of all) {
      expect(line).toMatch(/^[\x20-\x7E]*$/);
    }
  });
});
