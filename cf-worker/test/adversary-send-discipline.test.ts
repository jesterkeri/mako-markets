import { describe, expect, it } from 'vitest';
import { createWalletClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makoAbi } from '../src/abi';
import {
  newKeeperTick,
  newSendGate,
  runNoDataAction,
  sendOnce,
  type FinalizedRead,
  type KeeperIo,
  type ResolverTx,
} from '../src/settlement';

// Adversary probes of the one sender, driven through viem 2.50's real writeContract exactly as the Worker calls it
// (nonce pinned, gas and fees left to viem, so eth_fillTransaction / eth_estimateGas run).
//
// Monad's revert shape, read-only probe of https://testnet-rpc.monad.xyz on 2026-10-01, from the V4 resolver
// 0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1, resolveMarket(0, 3) on resolved market 0:
//   eth_estimateGas     -> {"code":3,"message":"execution reverted","data":"0x6d5703c2"}
//   eth_fillTransaction -> {"code":3,"message":"execution reverted","data":"0x6d5703c2"}
// 0x6d5703c2 = AlreadyResolved(), 0x4e6c024e = StillInGrace(), 0xa8a9eb69 = MarketNotClosed() (cast sig).

const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
});

type Rpc = { id: number; method: string; params?: unknown[] };
type Handler = (m: Rpc) => { result?: unknown; error?: unknown };

function stub(handler: Handler, seen: string[]) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const one = (m: Rpc) => {
      seen.push(m.method);
      if (m.method === 'eth_chainId') return { jsonrpc: '2.0', id: m.id, result: '0x279f' };
      return { jsonrpc: '2.0', id: m.id, ...handler(m) };
    };
    const parsed = JSON.parse(String(init?.body));
    const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  };
}

function workerSender(handler: Handler, seen: string[]) {
  const walletClient = createWalletClient({
    account: privateKeyToAccount(generatePrivateKey()),
    chain: monadTestnet,
    transport: http('http://monad-rpc.stub', { batch: true, retryCount: 0, fetchFn: stub(handler, seen) }),
  });
  return {
    readFinalized: async (): Promise<FinalizedRead> => ({
      market: { mType: 5, closeTime: 1_790_800_396n, totalYes: 1_000_000n, totalNo: 0n, resolved: false },
      blockNumber: 16n,
      blockTimestamp: 1_790_800_396n + 86_400n + 30n,
    }),
    nonceAt: async () => 252,
    send: (tx: { functionName: 'resolveMarket' | 'forceRefund'; args: readonly unknown[] }, nonce: number) =>
      walletClient.writeContract({
        address: '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
        abi: makoAbi as never,
        functionName: tx.functionName,
        args: tx.args as never,
        nonce,
      } as never),
    waitForReceipt: async () => 'timeout' as const,
  };
}

const revert = (data: string) => ({ error: { code: 3, message: 'execution reverted', data } });

describe('adversary: estimation refusals through the real viem path', () => {
  for (const [name, data] of [
    ['AlreadyResolved', '0x6d5703c2'],
    ['StillInGrace', '0x4e6c024e'],
    ['MarketNotClosed', '0xa8a9eb69'],
  ] as const) {
    it(`${name} at eth_fillTransaction frees the slot and broadcasts nothing`, async () => {
      const seen: string[] = [];
      const s = workerSender((m) => (m.method === 'eth_fillTransaction' || m.method === 'eth_estimateGas' ? revert(data) : { error: { code: -32601, message: 'nope' } }), seen);
      const gate = newSendGate();
      const r = await sendOnce(s, gate, { functionName: 'forceRefund', args: [5n] }, () => null);
      expect(seen).not.toContain('eth_sendRawTransaction');
      expect(r.kind).toBe(name === 'AlreadyResolved' ? 'already_resolved' : 'not_yet');
      expect(gate.broadcasts).toBe(0);
    });
  }
});

// Minimal latest block so viem can pick EIP-1559 fees when eth_fillTransaction is not used.
const BLOCK = {
  number: '0x10', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), timestamp: '0x6700000',
  baseFeePerGas: '0x174876e800', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], logsBloom: '0x' + '00'.repeat(256),
  miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', nonce: '0x0000000000000000', sha3Uncles: '0x' + '00'.repeat(32),
  size: '0x0', stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), uncles: [],
};

describe('adversary: out-of-funds at estimation through the real viem path', () => {
  for (const fillMode of ['unsupported', 'insufficient'] as const) {
    it(`fill ${fillMode}, estimateGas -32000 "insufficient balance" stops the tick`, async () => {
      const seen: string[] = [];
      const s = workerSender((m) => {
        if (m.method === 'eth_fillTransaction') {
          return fillMode === 'unsupported'
            ? { error: { code: -32601, message: 'Method not found' } }
            : { error: { code: -32000, message: 'insufficient balance' } };
        }
        if (m.method === 'eth_estimateGas') return { error: { code: -32000, message: 'insufficient balance' } };
        if (m.method === 'eth_getBlockByNumber') return { result: BLOCK };
        if (m.method === 'eth_maxPriorityFeePerGas') return { result: '0x77359400' };
        return { error: { code: -32601, message: `stub: ${m.method}` } };
      }, seen);
      const gate = newSendGate();
      const r = await sendOnce(s, gate, { functionName: 'forceRefund', args: [5n] }, () => null);
      expect(seen).not.toContain('eth_sendRawTransaction');
      expect(r.kind).toBe('out_of_funds');
      expect(gate.outOfFunds).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Spec "Send discipline" (mako-design/RESOLVER_ONE_SIDED_SPEC.md, item 2):
//   "If they differ, a resolver transaction has landed but is not final; nothing is sent this tick, since the
//    finalized re-reads cannot yet see its effect."
//
// Sequence (one Worker invocation, no memory of earlier runs):
//   - an earlier run's forceRefund(7) at nonce 4 had no receipt in time; it is included at block 101 during this
//     tick's scan, so the scan (and the tick's plan) still has market 7 unresolved;
//   - market 3 (one-sided) reaches the sender first: latest 5, finalized 4, so it is deferred;
//   - about a second later market 7 (planned force_refund) re-reads at the finalized block, still 100, which cannot
//     see block 101, and by the time its nonce is read finality has caught up: latest 5, finalized 5;
//   - the sender broadcasts forceRefund(7) again, at nonce 5, the same action as the one already included at 4.
// ---------------------------------------------------------------------------

const CLOSE = 1_790_800_396n; // market #92's real closeTime, as in settlement.test.ts
const DEADLINE = CLOSE + 86_400n;
const oneSided = { mType: 5, closeTime: CLOSE, totalYes: 1_000_000n, totalNo: 0n, resolved: false };

function scriptedIo(reads: Record<string, FinalizedRead>, nonces: Array<{ latest: number; finalized: number }>) {
  const sent: Array<{ tx: ResolverTx; nonce: number }> = [];
  const lines: string[] = [];
  let pair = -1;
  let half = 0;
  const io: KeeperIo = {
    async readFinalized(id) {
      return reads[id.toString()];
    },
    async nonceAt(tag) {
      // sendOnce reads latest and the count at its re-read's finalized block as one pair per attempt.
      if (half++ % 2 === 0) pair++;
      return nonces[Math.min(pair, nonces.length - 1)][tag === 'latest' ? 'latest' : 'finalized'];
    },
    async send(tx, nonce) {
      sent.push({ tx, nonce });
      return '0xbbb';
    },
    async waitForReceipt() {
      return { status: 'success', blockNumber: 102n };
    },
    log: (l) => lines.push(l),
    warn: (l) => lines.push(l),
  };
  return { io, sent, lines };
}

describe('adversary: "nothing is sent this tick" once latest and finalized differ', () => {
  it('no-data path: a later market in the same tick is not broadcast after an unfinalized deferral', async () => {
    const s = scriptedIo(
      {
        '3': { market: oneSided, blockNumber: 100n, blockTimestamp: DEADLINE - 600n },
        '7': { market: { ...oneSided, closeTime: CLOSE - 1_000n }, blockNumber: 100n, blockTimestamp: DEADLINE + 30n },
      },
      [
        { latest: 5, finalized: 4 },
        { latest: 5, finalized: 5 },
      ],
    );
    const tick = newKeeperTick('t', false, { forceRefundTwoSided: false });
    expect(await runNoDataAction(s.io, tick, 3n, 'resolve_one_sided')).toBe('deferred');
    await runNoDataAction(s.io, tick, 7n, 'force_refund');
    expect(s.sent).toEqual([]);
  });

  it('price path: after the no-data pass was deferred as unfinalized, the price send of the same tick is not broadcast', async () => {
    const s = scriptedIo(
      {
        '3': { market: oneSided, blockNumber: 100n, blockTimestamp: DEADLINE - 600n },
        // [author, after the fix] The sender now re-reads the market it sends for, so market 9 (two-sided, due) is
        // scripted too; unscripted, the read came back undefined and the send failed for that reason instead.
        '9': { market: { ...oneSided, mType: 1, totalNo: 2_000_000n }, blockNumber: 100n, blockTimestamp: DEADLINE - 600n },
      },
      [
        { latest: 5, finalized: 4 },
        { latest: 5, finalized: 5 },
      ],
    );
    const tick = newKeeperTick('t', false, { forceRefundTwoSided: false });
    expect(await runNoDataAction(s.io, tick, 3n, 'resolve_one_sided')).toBe('deferred');
    // index.ts calls sendOnce(keeperIo, keeperTick.gate, ...) for each two-sided pool after the no-data pass.
    await sendOnce(s.io, tick.gate, { functionName: 'resolveMarket', args: [9n, 1] }, () => null);
    expect(s.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The same guard on the FIRST send of a tick, with no earlier deferral. A small chain model: an earlier run's
// forceRefund(7) at nonce 4 is in block 101; the finalized head moves from 100 to 101 after the tick's first chain
// read. Whatever order a sender reads in, "latest == finalized" must mean its finalized re-read already sees block
// 101. Only the sender's own guards are modelled here: `send` records a broadcast and does not simulate viem's gas
// estimation, which on a node that already has block 101 would refuse AlreadyResolved as a second line of defence.
// ---------------------------------------------------------------------------

describe('adversary: latest == finalized must imply the finalized re-read sees the landed transaction', () => {
  it('does not broadcast forceRefund(7) again at nonce 5 on a re-read taken before finality reached block 101', async () => {
    let calls = 0;
    const finalizedHead = () => (calls > 1 ? 101n : 100n);
    const sent: Array<{ tx: ResolverTx; nonce: number }> = [];
    const io: KeeperIo = {
      async readFinalized(id) {
        calls++;
        const head = finalizedHead();
        const resolved = id === 7n && head >= 101n;
        return {
          market: { mType: 5, closeTime: CLOSE - 1_000n, totalYes: 1_000_000n, totalNo: 0n, resolved },
          blockNumber: head,
          blockTimestamp: DEADLINE + 30n,
        };
      },
      async nonceAt(tag) {
        calls++;
        if (tag === 'latest') return 5;
        // [author, after the fix] The sender now reads the count at a block number (its re-read's block), so the
        // model answers per block: the forceRefund(7) at nonce 4 is in block 101.
        return tag >= 101n ? 5 : 4;
      },
      async send(tx, nonce) {
        sent.push({ tx, nonce });
        return '0xccc';
      },
      async waitForReceipt() {
        return { status: 'success', blockNumber: 102n };
      },
      log: () => {},
      warn: () => {},
    };
    const tick = newKeeperTick('t', false, { forceRefundTwoSided: false });
    await runNoDataAction(io, tick, 7n, 'force_refund');
    expect(sent).toEqual([]);
  });
});
