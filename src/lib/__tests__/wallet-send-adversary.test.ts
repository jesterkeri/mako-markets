// Adversary pass on Codex S4 r2 (2794f4b): sendUsdcFromWallet against a real viem public client.
//
// Spec rule 2: the send is reported "sent" ONLY after a successful on-chain receipt (of the send). Here the browser
// wallet's own "Cancel" replaces the transfer with a 0-value self-send at the same nonce before it lands. viem 2.47's
// waitForTransactionReceipt (actions/public/waitForTransactionReceipt.ts, checkReplacement defaults to true) then
// resolves with the CANCEL transaction's receipt, status success. No USDC moved, so the send must not be "sent".
//
// Fixtures: JSON-RPC responses built with viem's own encoders (encodeFunctionData, numberToHex) in the standard
// eth_getTransactionByHash / eth_getBlockByNumber / eth_getTransactionReceipt shapes. No live network.

import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, encodeFunctionData, erc20Abi, numberToHex } from 'viem';
import { sendUsdcFromWallet } from '@/lib/wallet-send';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const TO = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const USDC = '0x534b2f3a21130d7a60830c2df862319e593943a3' as const;
const HASH = `0x${'d4'.repeat(32)}` as const; // the transfer the wallet broadcast
const CANCEL = `0x${'ee'.repeat(32)}` as const; // the wallet's cancel at the same nonce
const BLOCK_HASH = `0x${'0b'.repeat(32)}` as const;
const BLOCK = 0x10n;
const NONCE = 5;

const rpcTx = (over: Record<string, unknown>) => ({
  blockHash: null,
  blockNumber: null,
  transactionIndex: null,
  from: A,
  gas: numberToHex(100_000n),
  gasPrice: numberToHex(50_000_000_000n),
  nonce: numberToHex(NONCE),
  type: '0x0',
  chainId: numberToHex(10143),
  v: '0x1b',
  r: `0x${'01'.repeat(32)}`,
  s: `0x${'02'.repeat(32)}`,
  ...over,
});

const transfer = rpcTx({
  hash: HASH,
  to: USDC,
  value: '0x0',
  input: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [TO, 5_000_000n] }),
});
const cancel = rpcTx({
  hash: CANCEL,
  to: A,
  value: '0x0',
  input: '0x',
  gasPrice: numberToHex(80_000_000_000n),
  blockHash: BLOCK_HASH,
  blockNumber: numberToHex(BLOCK),
  transactionIndex: '0x0',
});
const cancelReceipt = {
  transactionHash: CANCEL,
  transactionIndex: '0x0',
  blockHash: BLOCK_HASH,
  blockNumber: numberToHex(BLOCK),
  from: A,
  to: A,
  cumulativeGasUsed: numberToHex(21_000n),
  gasUsed: numberToHex(21_000n),
  effectiveGasPrice: numberToHex(80_000_000_000n),
  contractAddress: null,
  logs: [],
  logsBloom: `0x${'00'.repeat(256)}`,
  status: '0x1',
  type: '0x0',
};

function chainWhereTheTransferWasCancelled() {
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case 'eth_chainId':
        return numberToHex(10143);
      case 'eth_blockNumber':
        return numberToHex(BLOCK);
      case 'eth_getTransactionByHash':
        return params?.[0] === HASH ? transfer : null; // seen pending before the cancel landed
      case 'eth_getTransactionReceipt':
        return params?.[0] === CANCEL ? cancelReceipt : null; // the transfer never gets a receipt
      case 'eth_getBlockByNumber':
        return {
          number: numberToHex(BLOCK),
          hash: BLOCK_HASH,
          parentHash: `0x${'0a'.repeat(32)}`,
          timestamp: '0x6700000',
          transactions: [cancel],
        };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return createPublicClient({ transport: custom({ request }), pollingInterval: 20 });
}

describe('sendUsdcFromWallet: a cancelled transfer is never "sent"', () => {
  it('the wallet cancels the transfer at the same nonce: no USDC moved, so the outcome is not sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = chainWhereTheTransferWasCancelled();
    const out = await sendUsdcFromWallet(
      { sender: A, usdc: USDC, to: TO, amount: 5_000_000n, chainId: 10143 },
      {
        connectedNow: () => A,
        writeContractAsync: async () => HASH,
        // Passed unbound, exactly as src/app/profile/page.tsx does.
        waitForTransactionReceipt: client.waitForTransactionReceipt,
      },
    );
    expect(out.kind).not.toBe('sent');
  }, 15_000);
});
