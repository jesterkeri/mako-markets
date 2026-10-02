// Codex S4 r2: the /profile USDC send from an external wallet. The sender is pinned to the signed-in wallet and the
// send is reported sent only on a successful receipt.
//
// The wallet model follows @wagmi/core (src/actions/getConnectorClient.ts): a write naming an account the connector
// no longer holds throws ConnectorAccountNotFoundError before the wallet sees it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendUsdcFromWallet, SEND_RECEIPT_TIMEOUT_MS } from '@/lib/wallet-send';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const TO = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const USDC = '0x534b2f3A21130d7a60830c2Df862319e593943A3' as const;
const HASH = `0x${'d4'.repeat(32)}` as const;
const REQ = { sender: A, usdc: USDC, to: TO, amount: 5_000_000n };

let connected: `0x${string}` | undefined;
/// The wallet each transfer was actually shown to.
let asked: string[];
const write = vi.fn();
const receipt = vi.fn();

function deps(onBroadcast?: (h: `0x${string}`) => void) {
  return { connectedNow: () => connected, writeContractAsync: write, waitForTransactionReceipt: receipt, onBroadcast };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  connected = A;
  asked = [];
  write.mockImplementation(async (req: { account?: string }) => {
    if (req.account && (!connected || req.account.toLowerCase() !== connected.toLowerCase())) {
      throw Object.assign(new Error('Account not found for connector.'), { name: 'ConnectorAccountNotFoundError' });
    }
    asked.push((req.account ?? connected) as string);
    return HASH;
  });
  receipt.mockResolvedValue({ status: 'success' });
});

describe('sendUsdcFromWallet: the sender is pinned', () => {
  it('a wallet switched after Review is never asked, and the send is not reported', async () => {
    connected = B; // A was connected at Review; the browser wallet is now B
    const out = await sendUsdcFromWallet(REQ, deps());
    expect(out).toEqual({ kind: 'wallet_changed' });
    expect(asked).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it('a switch between the re-check and the wallet request is refused by wagmi, never sent from B', async () => {
    const original = write.getMockImplementation()!;
    write.mockImplementation(async (req) => {
      connected = B; // the switch lands while the write is being prepared
      return original(req);
    });
    const out = await sendUsdcFromWallet(REQ, deps());
    expect(out).toEqual({ kind: 'wallet_changed' });
    expect(asked).toEqual([]);
  });

  it('names the signed-in wallet as the account, with the exact transfer', async () => {
    await sendUsdcFromWallet(REQ, deps());
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0]![0];
    expect(call).toMatchObject({ address: USDC, functionName: 'transfer', args: [TO, 5_000_000n], account: A });
    expect(asked).toEqual([A]);
  });

  it('no connected wallet is a wallet change, not a send', async () => {
    connected = undefined;
    expect(await sendUsdcFromWallet(REQ, deps())).toEqual({ kind: 'wallet_changed' });
    expect(write).not.toHaveBeenCalled();
  });

  it('a wallet rejection is reported as rejected, with nothing broadcast', async () => {
    write.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError' }));
    const onBroadcast = vi.fn();
    expect(await sendUsdcFromWallet(REQ, deps(onBroadcast))).toEqual({ kind: 'rejected' });
    expect(onBroadcast).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
  });
});

describe('sendUsdcFromWallet: sent only on a successful receipt', () => {
  it('success receipt: sent, after the hash was broadcast and the receipt awaited with a timeout', async () => {
    const onBroadcast = vi.fn();
    expect(await sendUsdcFromWallet(REQ, deps(onBroadcast))).toEqual({ kind: 'sent', txHash: HASH });
    expect(onBroadcast).toHaveBeenCalledWith(HASH);
    expect(receipt).toHaveBeenCalledWith({ hash: HASH, timeout: SEND_RECEIPT_TIMEOUT_MS });
    expect(onBroadcast.mock.invocationCallOrder[0]).toBeLessThan(receipt.mock.invocationCallOrder[0]!);
  });

  it('reverted receipt: reverted, never sent', async () => {
    receipt.mockResolvedValueOnce({ status: 'reverted' });
    expect(await sendUsdcFromWallet(REQ, deps())).toEqual({ kind: 'reverted', txHash: HASH });
  });

  it('receipt timeout: unconfirmed with the hash, never sent', async () => {
    receipt.mockRejectedValueOnce(Object.assign(new Error('Timed out while waiting for transaction'), { name: 'WaitForTransactionReceiptTimeoutError' }));
    expect(await sendUsdcFromWallet(REQ, deps())).toEqual({ kind: 'unconfirmed', txHash: HASH });
  });

  it('transport failure while waiting: unconfirmed with the hash, never sent', async () => {
    receipt.mockRejectedValueOnce(new Error('HTTP request failed'));
    expect(await sendUsdcFromWallet(REQ, deps())).toEqual({ kind: 'unconfirmed', txHash: HASH });
  });

  it('no Monad client: unconfirmed with the hash, never sent', async () => {
    const out = await sendUsdcFromWallet(REQ, { ...deps(), waitForTransactionReceipt: undefined });
    expect(out).toEqual({ kind: 'unconfirmed', txHash: HASH });
  });

  it('a receipt that has not arrived leaves the send pending, not sent', async () => {
    vi.useFakeTimers();
    try {
      receipt.mockReturnValueOnce(new Promise(() => {}));
      let settled = false;
      void sendUsdcFromWallet(REQ, deps()).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(10_000); // the old code reported "sent" after 3 s
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
