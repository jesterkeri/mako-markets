// Adversarial runs of the keeper over many consecutive minutes against a fake chain that holds several
// rounds, each with its own close time, and settles or reverts what is sent. Nothing leaves the machine.
//
// Contract checked (SPEC.md §5.5, TASKS.md T0.1c, owner decision 2026-09-28):
//   - every 60 s the keeper takes one round; a failed round is retried, alerted after 30 minutes, and refunds
//     (NoPrice) only because ITS OWN report is missing for 24 hours;
//   - keeper-only: every round settled within 10 minutes of closeTime (T0.1c latency);
//   - a failure must alert rather than silently miss settlement.

import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { ROUNDS_ABI } from '../../rounds-delivery/src/index';
import { ROUNDS_REFUND_ABI } from '../src/abi-refunds';
import { refundAnswer } from './refund-fake';
import { makeNet } from '../src/net';
import { runKeeper, type Deps, type RunConfig, type TxRequest } from '../src/run';
import { INITIAL_META, type InFlight, type Meta } from '../src/state';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const ROUNDS = '0x00000000000000000000000000000000000A11CE' as Hex;
const KEEPER = '0x0000000000000000000000000000000000000B0B' as Hex;
const RPC = 'https://rpc.test';
const DS = 'https://ds.test';
const cfg: RunConfig = {
  roundsAddress: ROUNDS,
  keeperAddress: KEEPER,
  rpcUrl: RPC,
  datastreamsUrl: DS,
  datastreamsKey: 'k',
  datastreamsSecret: 's',
  dryRun: false,
  poolsAddress: '0x0000000000000000000000000000000000000900',
  breakerResetAt: null,
};

const DURATION = 900;
const SUBMIT_WINDOW = 86_400;
const C = 1_789_530_060; // a minute mark, like every closeTime (startTime % 60 == 0, DURATION 900)

type Landing = 'success' | 'revert' | 'never-mined';

interface Round {
  close: number;
  /// The close report's spread is over MAX_SPREAD_BPS: `settle` reverts SpreadTooWide for this round, forever.
  wideSpread?: boolean;
  settledAt?: number;
  refundedAt?: number;
}

class Chain {
  now = 0; // seconds
  rounds = new Map<bigint, Round>();
  landing: Landing = 'success';
  receipts = new Map<string, { status: string }>();
  rawRound = new Map<string, bigint>();
  rawRefund = new Set<string>();
  mined = 0;
  sends: { round: bigint; at: number }[] = [];
  pings: { kind: string; body: string; at: number }[] = [];
  statuses: string[] = [];
  meta: Meta = structuredClone(INITIAL_META);
  signed = 0;

  pending(): bigint[] {
    return [...this.rounds.entries()]
      .filter(([, r]) => r.settledAt === undefined && r.refundedAt === undefined && this.now >= r.close && this.now < r.close + SUBMIT_WINDOW)
      .map(([id]) => id);
  }

  answer(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'eth_call': {
        const data = (params[0] as { data: Hex }).data;
        // Refund views, from the rounds this chain holds (ids 1..n), and no V4 pools.
        const world = {
          rounds: [...this.rounds.values()].map((r) => ({
            start: r.close - DURATION,
            status: r.settledAt !== undefined ? 2 : r.refundedAt !== undefined ? 3 : 1,
            up: 1n,
            down: 1n,
          })),
          markets: [],
        };
        const refund = refundAnswer(params[0] as { to: Hex; data: Hex }, ROUNDS, cfg.poolsAddress, world);
        if (refund) return refund;
        if (data.startsWith(encodeFunctionData({ abi: ROUNDS_REFUND_ABI, functionName: 'finalizeRefund', args: [0n] }).slice(0, 10))) {
          const id = decodeFunctionData({ abi: ROUNDS_REFUND_ABI, data }).args![0] as bigint;
          const why = this.refundRevert(id);
          if (why) return { error: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: ROUNDS_ABI, errorName: why as never }) } };
          return { result: '0x' };
        }
        const { functionName, args } = decodeFunctionData({ abi: ROUNDS_ABI, data });
        if (functionName === 'pendingSettlement')
          return { result: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', result: this.pending() }) };
        if (functionName === 'DURATION') return { result: encodeAbiParameters([{ type: 'uint64' }], [BigInt(DURATION)]) };
        if (functionName === 'closeTimeOf') {
          const r = this.rounds.get(args![0] as bigint)!;
          return { result: encodeAbiParameters([{ type: 'uint64' }], [BigInt(r.close)]) };
        }
        const why = this.settleRevert(args![0] as bigint);
        if (why) return { error: { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: ROUNDS_ABI, errorName: why as never }) } };
        return { result: '0x' };
      }
      case 'eth_estimateGas':
        return { result: '0x' + (300_000).toString(16) };
      case 'eth_getBlockByNumber':
        return { result: { baseFeePerGas: '0x' + (50n * 10n ** 9n).toString(16) } };
      case 'eth_maxPriorityFeePerGas':
        return { result: '0x' + (2n * 10n ** 9n).toString(16) };
      case 'eth_getBalance':
        return { result: '0x' + (10n ** 20n).toString(16) };
      case 'eth_getTransactionCount':
        return { result: '0x' + this.mined.toString(16) };
      case 'eth_getTransactionReceipt':
        return { result: this.receipts.get(params[0] as string) ?? null };
      case 'eth_sendRawTransaction': {
        const raw = params[0] as Hex;
        const hash = keccak256(raw);
        const round = this.rawRound.get(raw)!;
        const isRefund = this.rawRefund.has(raw);
        this.sends.push({ round, at: this.now });
        if (this.landing === 'never-mined') return { result: hash };
        this.mined++;
        const ok = this.landing === 'success' && (isRefund ? this.refundRevert(round) : this.settleRevert(round)) === null;
        if (ok && isRefund) this.rounds.get(round)!.refundedAt = this.now;
        else if (ok) this.rounds.get(round)!.settledAt = this.now;
        this.receipts.set(hash, { status: ok ? '0x1' : '0x0' });
        return { result: hash };
      }
    }
    return { error: { code: -32601 } };
  }

  /// finalizeRefund as MakoRoundsV1 decides it for these two-sided rounds: NoPrice once the window has passed.
  refundRevert(id: bigint): string | null {
    const r = this.rounds.get(id)!;
    if (r.settledAt !== undefined || r.refundedAt !== undefined) return 'RoundAlreadyTerminal';
    if (this.now < r.close + SUBMIT_WINDOW) return 'NotRefundableYet';
    return null;
  }

  settleRevert(id: bigint): string | null {
    const r = this.rounds.get(id)!;
    if (r.settledAt !== undefined || r.refundedAt !== undefined) return 'RoundAlreadyTerminal';
    if (this.now < r.close) return 'TooEarlyToSettle';
    if (this.now >= r.close + SUBMIT_WINDOW) return 'SubmitWindowClosed';
    if (r.wideSpread) return 'SpreadTooWide';
    return null;
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(RPC)) {
      const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
      return Response.json(calls.map((c) => ({ jsonrpc: '2.0', id: c.id, ...(this.answer(c.method, c.params) as object) })));
    }
    if (url.startsWith(DS)) {
      const b = Number(new URL(url).searchParams.get('timestamp'));
      return Response.json({
        report: { feedID: fixture.feedID, validFromTimestamp: b, observationsTimestamp: b, fullReport: fixture.fullReport },
      });
    }
    throw new Error('unexpected url');
  }) as typeof fetch;

  deps(): Deps {
    const nowMs = () => this.now * 1000;
    return {
      net: makeNet(this.fetch, nowMs, async () => {}, nowMs() + 40_000, 11),
      state: {
        acquire: async () => ({ ok: true as const, token: 1, meta: structuredClone(this.meta) }),
        recordInFlight: async (_t: number, f: InFlight) => {
          this.meta = { ...this.meta, inFlight: f };
          return { ok: true };
        },
        commit: async (_t: number, m: Meta) => {
          this.meta = structuredClone(m);
          return { ok: true };
        },
      },
      sign: async (tx: TxRequest) => {
        // A distinct serialized transaction per signature, remembered so the fake chain knows its round.
        const raw = ('0x02' + (++this.signed).toString(16).padStart(8, '0') + tx.nonce.toString(16).padStart(8, '0')) as Hex;
        let decoded;
        try {
          decoded = decodeFunctionData({ abi: ROUNDS_ABI, data: tx.data });
        } catch {
          decoded = decodeFunctionData({ abi: ROUNDS_REFUND_ABI, data: tx.data });
          this.rawRefund.add(raw);
        }
        this.rawRound.set(raw, decoded.args![0] as bigint);
        return raw;
      },
      hmac: async () => 'ab'.repeat(32),
      ping: async (kind, body) => {
        this.pings.push({ kind, body, at: this.now });
      },
    };
  }

  /// One cron run a minute, `minutes` times, starting at `from` (seconds).
  async cron(from: number, minutes: number): Promise<void> {
    for (let i = 0; i < minutes; i++) {
      this.now = from + i * 60;
      const o = await runKeeper(cfg, this.deps());
      this.statuses.push(o.status);
    }
  }
}

describe('adversary: one round that cannot settle', () => {
  it('does not stop other rounds, with valid reports, from settling before their own submitDeadline', async () => {
    const chain = new Chain();
    // Round 1's close report has a spread over 50 bps: SPEC §5.2 step 6 makes settle revert, so round 1 can
    // only refund at its submitDeadline. Rounds 2 and 3 close a minute later and have perfectly good reports.
    chain.rounds.set(1n, { close: C, wideSpread: true });
    chain.rounds.set(2n, { close: C + 60 });
    chain.rounds.set(3n, { close: C + 60 });

    // Every minute from 5 minutes past round 1's close until after every round's submitDeadline.
    await chain.cron(C + 300, (SUBMIT_WINDOW + 60) / 60 + 5);

    // A valid round must be settled, and by the keeper alone within 10 minutes of its close (T0.1c).
    const failures = [2n, 3n].flatMap((id) => {
      const r = chain.rounds.get(id)!;
      if (r.settledAt === undefined) return [`round ${id} never settled: it refunds NoPrice despite valid reports`];
      if (r.settledAt - r.close > 600) return [`round ${id} settled ${r.settledAt - r.close} s after close`];
      return [];
    });
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('adversary: a failure that repeats must alert', () => {
  it('pings /fail when every transaction it sends reverts on chain', async () => {
    const chain = new Chain();
    chain.rounds.set(7n, { close: C });
    // Simulation and estimate pass, but the mined transaction reverts (e.g. the limit, estimate + 20% capped
    // at 1,000,000, is too tight on execution). The round is never settled.
    chain.landing = 'revert';

    await chain.cron(C + 300, 30);

    expect(chain.rounds.get(7n)!.settledAt).toBeUndefined();
    // Thirty minutes of failed settlement, full gas charged every time, must reach Healthchecks as a failure.
    expect(chain.sends.length).toBeGreaterThan(1);
    expect(chain.pings.filter((p) => p.kind === 'fail').length, `statuses: ${chain.statuses.join(',')}`).toBeGreaterThan(0);
  });

  it('pings /fail when every transaction it sends is accepted but never mined', async () => {
    const chain = new Chain();
    chain.rounds.set(7n, { close: C });
    chain.landing = 'never-mined';

    await chain.cron(C + 300, 30);

    expect(chain.rounds.get(7n)!.settledAt).toBeUndefined();
    expect(chain.pings.filter((p) => p.kind === 'fail').length, `statuses: ${chain.statuses.join(',')}`).toBeGreaterThan(0);
  });
});

describe('adversary: one round every 60 seconds (SPEC §5.5 step 1)', () => {
  it('settles five rounds closing in the same second within 10 minutes of close, keeper alone', async () => {
    const chain = new Chain();
    for (let id = 1n; id <= 5n; id++) chain.rounds.set(id, { close: C });

    // Cron fires on the minute; the first run that may take a round is exactly 5 minutes after close.
    await chain.cron(C + 300, 20);

    const late = [...chain.rounds.entries()]
      .filter(([, r]) => r.settledAt === undefined || r.settledAt - r.close > 600)
      .map(([id, r]) => `round ${id}: ${r.settledAt === undefined ? 'unsettled' : `${r.settledAt - r.close} s`}`);
    expect(late, `statuses: ${chain.statuses.slice(0, 12).join(',')}`).toEqual([]);
  });
});
