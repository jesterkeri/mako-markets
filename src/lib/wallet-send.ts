import { erc20Abi } from 'viem';

/// A USDC send from an external (browser) wallet, from Review to its receipt (Codex S4 r2).
///
/// The sender is pinned: the wallet connected right now is re-read immediately before the write and must equal it,
/// and the write names it as its `account`, so a wallet switched after Review is never asked to sign (wagmi refuses
/// a named account the connector no longer holds, before the wallet sees it). The send is reported sent only on a
/// successful receipt; a receipt that never arrives is an unknown outcome carrying the hash, never a success.

export type WalletSendOutcome =
  | { kind: 'wallet_changed' }
  | { kind: 'rejected' }
  | { kind: 'sent'; txHash: `0x${string}` }
  | { kind: 'reverted'; txHash: `0x${string}` }
  | { kind: 'unconfirmed'; txHash: `0x${string}` };

export interface WalletSendDeps {
  /// The wallet connected as of the latest render.
  connectedNow: () => `0x${string}` | undefined;
  writeContractAsync: (req: {
    address: `0x${string}`;
    abi: typeof erc20Abi;
    functionName: 'transfer';
    args: readonly [`0x${string}`, bigint];
    account: `0x${string}`;
  }) => Promise<`0x${string}`>;
  waitForTransactionReceipt:
    | ((req: { hash: `0x${string}`; timeout: number }) => Promise<{ status: 'success' | 'reverted' }>)
    | undefined;
  /// Called once the wallet returns a hash, before the receipt wait.
  onBroadcast?: (txHash: `0x${string}`) => void;
}

/// How long a wallet send waits for its receipt before reporting it as unconfirmed rather than sent.
export const SEND_RECEIPT_TIMEOUT_MS = 60_000;

/// wagmi's refusal when a write names an account the connector no longer has.
const isAccountNotConnected = (err: unknown) =>
  (err as { name?: string } | null)?.name === 'ConnectorAccountNotFoundError';

export async function sendUsdcFromWallet(
  req: { sender: `0x${string}`; usdc: `0x${string}`; to: `0x${string}`; amount: bigint },
  deps: WalletSendDeps,
): Promise<WalletSendOutcome> {
  const now = deps.connectedNow();
  if (!now || now.toLowerCase() !== req.sender.toLowerCase()) return { kind: 'wallet_changed' };
  let txHash: `0x${string}`;
  try {
    txHash = await deps.writeContractAsync({
      address: req.usdc,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [req.to, req.amount],
      account: req.sender,
    });
  } catch (e) {
    if (isAccountNotConnected(e)) return { kind: 'wallet_changed' };
    console.error('Send failed via external wallet', e);
    return { kind: 'rejected' };
  }
  deps.onBroadcast?.(txHash);
  try {
    if (!deps.waitForTransactionReceipt) throw new Error('No Monad client');
    const receipt = await deps.waitForTransactionReceipt({ hash: txHash, timeout: SEND_RECEIPT_TIMEOUT_MS });
    return receipt.status === 'success' ? { kind: 'sent', txHash } : { kind: 'reverted', txHash };
  } catch (e) {
    console.error('Could not confirm the wallet send', e);
    return { kind: 'unconfirmed', txHash };
  }
}
