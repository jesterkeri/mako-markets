'use client';

import { useRef, useState } from 'react';
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';

import type { ConfirmPhase } from '@/components/ConfirmSheet';
import { runSendUsdc, type RunOutcome } from './aa-client';
import { SEND_USDC_MAX_PER_OP_BASE_UNITS } from './aa-constants';
import { explorerUrl, MONAD_TESTNET_ID } from './chain';
import { phaseFromOutcome } from './confirm-outcome';
import { useEnsureMonadChain } from './hooks';
import { usdc2 } from './pool-list';
import { USDC_ADDRESS } from './usdc';
import { accountAddress, type AuthedUser } from './use-user';
import { isProtocolRecipient } from './protocol-recipients';
import { checkHold, holdSend } from './send-holds';
import { sendUsdcFromWallet, type WalletSendOutcome } from './wallet-send';

// Send USDC from /wallet. An email account sends from its Safe, gas-free, through the sponsor; a wallet account
// sends from its own wallet and pays gas. Either way the confirm-in-wallet sheet (19a) shows what the transaction
// is really doing, and "sent" is only ever said of a transfer that landed.

type Failed = Extract<ConfirmPhase, { step: 'failed' }>;
const close = { label: 'Close' } as const;
const retry = { label: 'Try again', retry: true } as const;
function failed(title: string, body: string, nothingMoved: boolean, primary: Failed['primary'] = retry, txHash?: string): Failed {
  return { step: 'failed', title, body, nothingMoved, primary, secondary: close, ...(txHash ? { txHash } : {}) };
}

const FAIL_TITLE = 'Send didn’t go through';

/// The per-send ceiling the gas sponsor enforces for email accounts (src/lib/aa-call-allowlist.ts).
export const EMAIL_SEND_CAP = SEND_USDC_MAX_PER_OP_BASE_UNITS;

export type SendCheck = { ok: true; to: Address; amount: bigint } | { ok: false; error: string };

/// The form's checks, before anything is asked of a wallet. `balance` is undefined until it has loaded.
export function checkSend(input: { to: string; amount: string }, ctx: { self: Address; balance: bigint | undefined; email: boolean }): SendCheck {
  // An all-uppercase address carries no checksum, like an all-lowercase one: compare it as lowercase.
  const raw = input.to.trim();
  const to = /^0x[0-9A-F]{40}$/.test(raw) ? `0x${raw.slice(2).toLowerCase()}` : raw;
  // Strict: a mixed-case address must carry a valid checksum, so a mistyped checksummed address is refused
  // (adversary on e442601). An all-lowercase address has no checksum to check and is accepted.
  if (!isAddress(to)) return { ok: false, error: 'Enter a valid 0x address. Check it was copied in full.' };
  const lower = to.toLowerCase();
  if (lower === ctx.self.toLowerCase()) return { ok: false, error: 'That is your own address.' };
  // The same list the gas sponsor refuses (src/lib/protocol-recipients.ts). Other contracts are allowed, with an
  // acknowledgement (useWalletSend.review), because every Mako Market email account is itself a contract.
  if (isProtocolRecipient(lower)) {
    return { ok: false, error: 'That is a Mako Market or USDC contract. USDC sent there can’t be got back.' };
  }
  const amountText = input.amount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(amountText)) return { ok: false, error: 'Enter an amount with a dot for decimals, up to 6 decimal places.' };
  const amount = parseUnits(amountText, 6);
  if (amount <= 0n) return { ok: false, error: 'Enter an amount above zero.' };
  if (ctx.balance === undefined) return { ok: false, error: 'Your balance hasn’t loaded yet. Try again in a moment.' };
  if (amount > ctx.balance) return { ok: false, error: `That is more than your balance (${usdc2(ctx.balance)} USDC).` };
  if (ctx.email && amount > EMAIL_SEND_CAP) return { ok: false, error: `Each send can be at most ${usdc2(EMAIL_SEND_CAP)} USDC.` };
  return { ok: true, to: getAddress(to), amount };
}

/// An amount exactly as it will be sent, never rounded: "1.995", "0.004", "12" (adversary on e442601).
export function exactUsdc(amount: bigint): string {
  return formatUnits(amount, 6);
}

/// The most this account can send in one go: its balance, capped per send for an email account.
export function maxSend(balance: bigint, email: boolean): bigint {
  return email && balance > EMAIL_SEND_CAP ? EMAIL_SEND_CAP : balance;
}

/// An email account's gas-free send, in the sheet's words.
export function emailSendPhase(o: RunOutcome, safe: Address): ConfirmPhase {
  if (o.kind === 'sponsor_failed' && o.status === 403) {
    if (o.reason === 'bad_send_recipient') return failed('Address not allowed', 'Mako Market can’t send to that address: it is your own account or a contract.', true, close);
    if (o.reason === 'bad_send_amount') return failed('Amount not allowed', `Each send can be at most ${usdc2(EMAIL_SEND_CAP)} USDC.`, true, close);
  }
  // A 409 from the send route means another request is already sending this operation: it may land.
  if (o.kind === 'send_failed' && o.status === 409) {
    return failed('Already sending', 'This send is already on its way. Check your wallet’s transactions before you send again.', false, {
      label: 'Open explorer',
      href: explorerUrl('address', safe),
    });
  }
  const p = phaseFromOutcome(o, { noun: 'send', failTitle: FAIL_TITLE, afterRevert: 'Check the address and amount and try again.' });
  // phaseFromOutcome sends unknown outcomes to Me, which lists bets, not sends: point at the account's own
  // transaction list instead.
  if (p.step === 'failed' && p.primary.href === '/me') {
    return { ...p, body: p.body.replace(/Check Me/g, 'Check your wallet’s transactions').replace(/check Me/g, 'check your wallet’s transactions'), primary: { label: 'Open explorer', href: explorerUrl('address', safe) } };
  }
  return p;
}

/// A wallet account's send, in the sheet's words. `from` is the sending wallet, for the explorer link.
export function walletSendPhase(o: WalletSendOutcome, from?: Address): ConfirmPhase {
  switch (o.kind) {
    case 'sent':
      return { step: 'done', txHash: o.txHash };
    case 'wallet_changed':
      return failed('Wallet changed', 'The wallet connected now isn’t the one you reviewed with. Nothing was sent.', true, close);
    case 'wrong_chain':
      return failed('Wrong network', 'Switch your wallet to Monad testnet, then review the send again.', true, close);
    case 'rejected':
      // Not a decline: the wallet may have broadcast before failing (a relay timeout), so this is an unknown
      // outcome with a way to check, never a plain "Try again" (adversary on 1e0fd99).
      return o.byUser
        ? { step: 'cancelled' }
        : failed(
            'Check before sending again',
            'Your wallet reported an error, so this send may or may not have gone out. Check your wallet’s activity before you send again.',
            false,
            from ? { label: 'Open explorer', href: explorerUrl('address', from) } : close,
          );
    case 'cancelled':
      return failed('Cancelled in your wallet', 'The send was replaced by a cancel in your wallet. No USDC was sent.', true, close, o.txHash);
    case 'reverted':
      return failed(FAIL_TITLE, 'Monad turned the send down, so it was undone. Check the address and amount and try again.', true, retry, o.txHash);
    case 'unconfirmed':
      return failed('Still confirming', 'Your send was broadcast but Monad hasn’t confirmed it yet. Check the transaction before you send again.', false, close, o.txHash);
  }
}

/// What Review found. `contract` and `unknown` ask the person to acknowledge the address and press Review again.
export type ReviewResult =
  | { kind: 'ok' }
  | { kind: 'error'; message: string }
  | { kind: 'acknowledge'; reason: 'contract' | 'unknown'; to: Address };

export type WalletSend = {
  /// The checked send the sheet is showing, or null when the sheet is closed.
  reviewed: { to: Address; amount: bigint } | null;
  phase: ConfirmPhase;
  /// `acknowledged` is the address the person ticked "I understand" for, if any.
  review: (input: { to: string; amount: string }, acknowledged?: string | null) => Promise<ReviewResult>;
  confirm: () => Promise<void>;
  retry: () => void;
  close: () => void;
};

/// `balance` is the account's USDC balance in base units, undefined until loaded. `onLanded` runs once a send lands.
/// `refresh` reloads the balance; it runs when the sheet closes after an outcome that may have moved funds.
export function useWalletSend(user: AuthedUser, balance: bigint | undefined, onLanded: () => void, refresh: () => void = () => {}): WalletSend {
  const email = user.authType === 'magic';
  const self = accountAddress(user);
  const { address: connected } = useAccount();
  /// The connected wallet as of the latest render: it can change while the sheet is open.
  const connectedNow = useRef(connected);
  connectedNow.current = connected;
  const publicClient = usePublicClient({ chainId: MONAD_TESTNET_ID });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();
  /// The balance as of the latest render: it can drop while the sheet is open.
  const balanceNow = useRef(balance);
  balanceNow.current = balance;

  const [reviewed, setReviewed] = useState<{ to: Address; amount: bigint } | null>(null);
  const [phase, setPhase] = useState<ConfirmPhase>({ step: 'review' });
  /// The wallet a wallet-account send was reviewed with: the signed-in one, never whatever is connected later.
  const sender = useRef<Address | null>(null);
  const inFlight = useRef(false);
  /// Set when this page produced an outcome that may have moved funds, so closing the sheet reloads the balance.
  const unresolved = useRef(false);

  const review = async (input: { to: string; amount: string }, acknowledged: string | null = null): Promise<ReviewResult> => {
    const r = await reviewInner(input, acknowledged);
    return typeof r === 'string' ? { kind: 'error', message: r } : r;
  };

  const reviewInner = async (input: { to: string; amount: string }, acknowledged: string | null): Promise<ReviewResult | string> => {
    const c = checkSend(input, { self, balance, email });
    if (!c.ok) return c.error;
    // A contract recipient is allowed (other Mako Market accounts are Safes) but never silently: the address must be
    // acknowledged first. If the chain can't be read, the same acknowledgement is asked (Codex batch r1 F1). This is
    // a check at Review time; an address can gain code later (a counterfactual Safe), which the wording allows for.
    if (acknowledged === null || acknowledged.toLowerCase() !== c.to.toLowerCase()) {
      let reason: 'contract' | 'unknown' | null;
      try {
        if (!publicClient) throw new Error('No Monad client');
        const code = await publicClient.getCode({ address: c.to });
        reason = code && code !== '0x' ? 'contract' : null;
      } catch {
        reason = 'unknown';
      }
      if (reason) return { kind: 'acknowledge', reason, to: c.to };
    }
    // A send whose outcome is unknown is held once, whatever happened in between: other reviews, a reload, another
    // tab (src/lib/send-holds.ts).
    if (checkHold(self, c.to, c.amount) === 'held') {
      return `Your last send of ${exactUsdc(c.amount)} USDC to this address isn’t confirmed yet and may have gone out. Check your wallet’s transactions first. Press Review send again to send it anyway.`;
    }
    if (!email) {
      const signedIn = user.walletAddress as Address;
      if (!connected) return `Connect ${signedIn.slice(0, 6)}…${signedIn.slice(-4)} in your browser wallet to send.`;
      if (connected.toLowerCase() !== signedIn.toLowerCase()) return 'Your browser wallet is not the one you signed in with. Switch back to send.';
      sender.current = signedIn;
    }
    setReviewed({ to: c.to, amount: c.amount });
    setPhase({ step: 'review' });
    return { kind: 'ok' };
  };

  /// Shows an outcome; one that may have moved funds is remembered against a repeat of the same send.
  const settle = (p: ConfirmPhase, sent: { to: Address; amount: bigint }) => {
    setPhase(p);
    if (p.step === 'done') onLanded();
    if (p.step === 'failed' && !p.nothingMoved) {
      holdSend(self, sent.to, sent.amount);
      unresolved.current = true;
    }
  };

  const confirm = async () => {
    if (!reviewed || inFlight.current) return;
    inFlight.current = true;
    try {
      // Re-checked at Send, not only at Review: the balance can drop while the sheet is open.
      const now = balanceNow.current;
      if (now === undefined || reviewed.amount > now) {
        setPhase(failed('Balance changed', `Your balance is now ${now === undefined ? 'unknown' : `${exactUsdc(now)} USDC`}, less than this send. Nothing was sent.`, true, close));
        return;
      }
      if (user.authType === 'magic') {
        setPhase({ step: 'pending', stage: 'signing' });
        let o: RunOutcome;
        try {
          o = await runSendUsdc({
            chainId: MONAD_TESTNET_ID,
            recipient: reviewed.to,
            amountUsdc: reviewed.amount,
            usdcAddress: USDC_ADDRESS,
            magicEoa: user.magicEoa as Address,
            onStage: (stage) => setPhase({ step: 'pending', stage }),
          });
        } catch {
          // A throw can come after the signed send was posted (a dropped connection), so the outcome is unknown,
          // never "nothing moved" (adversary on e442601; the same rule as confirm-outcome.ts).
          settle(
            failed('Lost the connection', 'Your send may still reach Monad. Check your wallet’s transactions before you try again.', false, {
              label: 'Open explorer',
              href: explorerUrl('address', self),
            }),
            reviewed,
          );
          return;
        }
        settle(emailSendPhase(o, self), reviewed);
        return;
      }
      const from = sender.current;
      if (!from) {
        setPhase(failed('Review again', 'Review the send again before sending.', true, close));
        return;
      }
      try {
        await ensureChain();
      } catch {
        setPhase(walletSendPhase({ kind: 'wrong_chain' }));
        return;
      }
      setPhase({ step: 'pending', stage: 'signing' });
      const o = await sendUsdcFromWallet(
        { sender: from, usdc: USDC_ADDRESS, to: reviewed.to, amount: reviewed.amount, chainId: MONAD_TESTNET_ID },
        {
          connectedNow: () => connectedNow.current,
          writeContractAsync,
          waitForTransactionReceipt: publicClient?.waitForTransactionReceipt,
          onBroadcast: (txHash) => setPhase({ step: 'pending', stage: 'confirming', txHash }),
        },
      );
      settle(walletSendPhase(o, from), reviewed);
    } finally {
      inFlight.current = false;
    }
  };

  return {
    reviewed,
    phase,
    review,
    confirm,
    retry: () => setPhase({ step: 'review' }),
    close: () => {
      if (inFlight.current) return;
      if (unresolved.current) refresh();
      unresolved.current = false;
      sender.current = null;
      setReviewed(null);
      setPhase({ step: 'review' });
    },
  };
}
