import { describe, expect, it } from 'vitest';
import { createWalletClient, defineChain, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makoAbi } from '../src/abi';
import {
  classifySendError,
  newKeeperTick,
  newSendGate,
  sendOnce,
  runNoDataAction,
  type KeeperIo,
} from '../src/settlement';

// ---------------------------------------------------------------------------
// Out-of-funds as Monad really reports it.
//
// A resolver wallet without MON for gas is not rejected by Monad at
// eth_fillTransaction / eth_estimateGas (read-only probe of
// https://testnet-rpc.monad.xyz on 2026-09-30: fillTransaction for a 0-balance
// sender succeeded). It is rejected by the txpool at eth_sendRawTransaction,
// and monad-rpc turns the drop reason into a JSON-RPC ServerError (-32000):
//
//   category-labs/monad-bft @ ac3ae48 (2026-09-29)
//   monad-eth-txpool-types/src/lib.rs:135
//     EthTxPoolDropReason::InsufficientBalance => "Signer had insufficient balance"
//   monad-rpc/src/handlers/eth/txn.rs:235-238
//     TxStatus::Dropped { reason } => Err(JsonRpcError::with_message(
//         ErrorCode::ServerError, reason.as_user_string()))
//
// The same wording without "Signer had" is what the public endpoint returned
// to eth_call / eth_estimateGas for an unfunded sender in the same probe:
//   {"code":-32000,"message":"insufficient balance"}
//
// The body is served by a JSON-RPC stub passed as the http transport's
// fetchFn, so viem's real http transport and writeContract build the error
// exactly as the Worker would receive it. Nothing leaves the machine and
// nothing is broadcast. (A fetchFn, not a node:http server: the Worker's
// typecheck has Workers types only, and CI installs cf-worker on its own.)
// ---------------------------------------------------------------------------

const MONAD_SIGNER_INSUFFICIENT = { code: -32000, message: 'Signer had insufficient balance' };

const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
});

const RPC_URL = 'http://monad-rpc.stub';
const seen: string[] = [];

async function stubFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const one = (m: { id: number; method: string }) => {
    seen.push(m.method);
    if (m.method === 'eth_chainId') return { jsonrpc: '2.0', id: m.id, result: '0x279f' };
    if (m.method === 'eth_sendRawTransaction') {
      return { jsonrpc: '2.0', id: m.id, error: MONAD_SIGNER_INSUFFICIENT };
    }
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `stub: ${m.method} not served` } };
  };
  const parsed = JSON.parse(String(init?.body));
  const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
}

// The Worker's own send, minus the fields a live node would fill in
// (gas, nonce, fees), which are fixed here so the stub only has to answer
// eth_sendRawTransaction.
async function sendLikeTheWorker(functionName: 'resolveMarket' | 'forceRefund', args: readonly unknown[], nonce = 0) {
  const walletClient = createWalletClient({
    account: privateKeyToAccount(generatePrivateKey()),
    chain: monadTestnet,
    transport: http(RPC_URL, { batch: true, retryCount: 0, fetchFn: stubFetch }),
  });
  return walletClient.writeContract({
    address: '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
    abi: makoAbi as never,
    functionName,
    args: args as never,
    gas: 100_000n,
    nonce,
    maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
  } as never);
}

async function thrownBy(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the send to throw');
}

describe("out-of-funds on Monad's real txpool error", () => {
  it('writeContract really reaches eth_sendRawTransaction and throws', async () => {
    const e = await thrownBy(sendLikeTheWorker('resolveMarket', [92n, 3]));
    expect(seen).toContain('eth_sendRawTransaction');
    expect(String((e as Error).message)).toMatch(/Signer had insufficient balance/);
  });

  it('classifySendError recognises "Signer had insufficient balance" as insufficient_funds', async () => {
    const e = await thrownBy(sendLikeTheWorker('resolveMarket', [92n, 3]));
    expect(classifySendError(e)).toBe('insufficient_funds');
  });

  it('runNoDataAction stops the tick (out_of_funds) when the resolver wallet has no MON', async () => {
    const io: KeeperIo = {
      readFinalized: async () => ({
        market: { mType: 1, closeTime: 1_790_800_396n, totalYes: 1_000_000n, totalNo: 0n, resolved: false },
        blockNumber: 1000n,
        blockTimestamp: 1_790_800_396n + 30n,
      }),
      nonceAt: async () => 0,
      send: (tx, nonce) => sendLikeTheWorker(tx.functionName, tx.args, nonce),
      waitForReceipt: async () => 'timeout',
      log: () => {},
      warn: () => {},
    };
    const tick = newKeeperTick('t', false, { forceRefundTwoSided: false });
    expect(await runNoDataAction(io, tick, 92n, 'resolve_one_sided')).toBe('out_of_funds');
  });

  it('the PRICE path stops on it too, and no later market is sent that tick (Codex r1 F1)', async () => {
    // The two-sided price/result path sends through the same sendOnce as the no-data path.
    const due = { mType: 1, closeTime: 1_790_800_396n, totalYes: 1_000_000n, totalNo: 2_000_000n, resolved: false };
    const sender = {
      readFinalized: async () => ({ market: due, blockNumber: 1000n, blockTimestamp: 1_790_800_396n + 30n }),
      nonceAt: async () => 0,
      send: (tx: { functionName: 'resolveMarket' | 'forceRefund'; args: readonly unknown[] }, nonce: number) => sendLikeTheWorker(tx.functionName, tx.args, nonce),
      waitForReceipt: async () => 'timeout' as const,
    };
    const gate = newSendGate();
    const raws = () => seen.filter((m) => m === 'eth_sendRawTransaction').length;
    const before = raws();
    expect(await sendOnce(sender, gate, { functionName: 'resolveMarket', args: [90n, 1] }, () => null)).toEqual({ kind: 'out_of_funds' });
    expect(gate.outOfFunds).toBe(true);
    expect(raws()).toBe(before + 1);
    // The next pool in the same tick, on either path: refused before anything is broadcast.
    expect(await sendOnce(sender, gate, { functionName: 'resolveMarket', args: [91n, 2] }, () => null)).toEqual({ kind: 'out_of_funds' });
    expect(await sendOnce(sender, gate, { functionName: 'forceRefund', args: [92n] }, () => null)).toEqual({ kind: 'out_of_funds' });
    expect(raws()).toBe(before + 1);
  });
});
