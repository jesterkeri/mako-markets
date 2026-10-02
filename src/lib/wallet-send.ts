import { BaseError, erc20Abi, UserRejectedRequestError } from 'viem';

/// A USDC send from an external (browser) wallet, from Review to its receipt (Codex S4 r2).
///
/// The sender is pinned: the wallet connected right now is re-read immediately before the write and must equal it,
/// and the write names it as its `account`, so a wallet switched after Review is never asked to sign (wagmi refuses
/// a named account the connector no longer holds, before the wallet sees it). The send is reported sent only on a
/// successful receipt OF THIS TRANSFER: a receipt that never arrives is an unknown outcome carrying the hash, and a
/// transfer the wallet cancelled or replaced at the same nonce is not a send, even though viem resolves with the
/// replacement's (successful) receipt (adversary on 2794f4b). A write naming the Monad chain is refused by wagmi
/// before the wallet sees it when the wallet is on another chain, so the transfer can never land elsewhere.

export type WalletSendOutcome =
  | { kind: 'wallet_changed' }
  /// The wallet refused or failed before broadcasting. `byUser` only when the person declined it in the wallet.
  | { kind: 'rejected'; byUser: boolean }
  | { kind: 'wrong_chain' }
  | { kind: 'cancelled'; txHash: `0x${string}` }
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
    chainId: number;
  }) => Promise<`0x${string}`>;
  waitForTransactionReceipt:
    | ((req: {
        hash: `0x${string}`;
        timeout: number;
        onReplaced: (r: { reason: 'cancelled' | 'replaced' | 'repriced' }) => void;
      }) => Promise<{ status: 'success' | 'reverted'; transactionHash: `0x${string}` }>)
    | undefined;
  /// Called once the wallet returns a hash, before the receipt wait.
  onBroadcast?: (txHash: `0x${string}`) => void;
}

/// How long a wallet send waits for its receipt before reporting it as unconfirmed rather than sent.
export const SEND_RECEIPT_TIMEOUT_MS = 60_000;

/// wagmi's refusals, both thrown before the wallet sees the request: a write naming an account the connector no longer
/// has, and a write naming a chain the connector is not on.
const errorName = (err: unknown) => (err as { name?: string } | null)?.name;
const isAccountNotConnected = (err: unknown) => errorName(err) === 'ConnectorAccountNotFoundError';
const isChainMismatch = (err: unknown) => errorName(err) === 'ConnectorChainMismatchError';

export async function sendUsdcFromWallet(
  req: { sender: `0x${string}`; usdc: `0x${string}`; to: `0x${string}`; amount: bigint; chainId: number },
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
      chainId: req.chainId,
    });
  } catch (e) {
    if (isAccountNotConnected(e)) return { kind: 'wallet_changed' };
    if (isChainMismatch(e)) return { kind: 'wrong_chain' };
    const byUser =
      errorName(e) === 'UserRejectedRequestError' ||
      (e instanceof BaseError && e.walk((c) => c instanceof UserRejectedRequestError) instanceof UserRejectedRequestError);
    if (!byUser) console.error('Send failed via external wallet', e);
    return { kind: 'rejected', byUser };
  }
  deps.onBroadcast?.(txHash);
  try {
    if (!deps.waitForTransactionReceipt) throw new Error('No Monad client');
    let replaced: 'cancelled' | 'replaced' | 'repriced' | null = null;
    const receipt = await deps.waitForTransactionReceipt({
      hash: txHash,
      timeout: SEND_RECEIPT_TIMEOUT_MS,
      onReplaced: (r) => {
        replaced = r.reason;
      },
    });
    // The same transfer, sped up in the wallet (same nonce, same call): its receipt is the transfer's.
    const ownReceipt =
      receipt.transactionHash.toLowerCase() === txHash.toLowerCase() || replaced === 'repriced';
    if (!ownReceipt) {
      // Cancelled (a 0-value self-send at the nonce) moved nothing; any other replacement is not this transfer.
      return replaced === 'cancelled' ? { kind: 'cancelled', txHash } : { kind: 'unconfirmed', txHash };
    }
    const landed = receipt.transactionHash as `0x${string}`;
    return receipt.status === 'success' ? { kind: 'sent', txHash: landed } : { kind: 'reverted', txHash: landed };
  } catch (e) {
    console.error('Could not confirm the wallet send', e);
    return { kind: 'unconfirmed', txHash };
  }
}
