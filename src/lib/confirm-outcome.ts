// How a gas-free action's result reads in the confirm sheet (19a). Every RunOutcome maps to exactly one phase, and
// the sheet says "No USDC left your wallet" only where the flow knows the action never reached Monad or was
// rolled back there. Unknown outcomes (sent but unconfirmed, a dropped connection after signing) say to check Me
// before trying again, so nobody pays twice.

import type { RunOutcome } from './aa-client';
import type { ConfirmPhase } from '@/components/ConfirmSheet';

type Failed = Extract<ConfirmPhase, { step: 'failed' }>;

/// `noun` names the action in sentences ("bet", "claim"); `failTitle` heads a plain failure ("Bet didn't go
/// through").
export type OutcomeWords = { noun: string; failTitle: string };

const close = { label: 'Close' } as const;
const retry = { label: 'Try again', retry: true } as const;
const checkMe = { label: 'Check Me', href: '/me' } as const;

function failed(title: string, body: string, nothingMoved: boolean, primary: Failed['primary'] = retry): Failed {
  return { step: 'failed', title, body, nothingMoved, primary, secondary: close };
}

/// A contract refusal found before sending (a wallet account's pre-flight simulation), in the pool page's words.
/// Nothing was sent, so nothing moved.
export function refusalPhase(errorName: string | undefined, w: OutcomeWords): ConfirmPhase {
  const words: Record<string, [string, string]> = {
    BettingClosed: ['Betting closed first', 'The pool closed before your bet reached Monad.'],
    AlreadyResolved: ['Already settled', 'This pool has its result, so it takes no more bets.'],
    BelowMin: ['Below the minimum', 'The minimum bet is 0.10 USDC.'],
    WalletIsBlocked: ['Wallet blocked', 'This wallet is blocked from betting on Mako Market pools.'],
    BetTooSoon: ['Too soon', 'One bet per pool every 30 seconds. Try again in a moment.'],
    WalletCapExceeded: ['Over the wallet limit', 'This bet would put more into the pool than one wallet may hold.'],
    WalletShareCapExceeded: ['Over the share limit', 'This bet would give your wallet too large a share of the pool. Try a smaller amount.'],
    NotResolved: ['Not settled yet', 'This pool has no result yet, so there is nothing to claim.'],
    AlreadyClaimed: ['Already claimed', 'This payout was already claimed. Check your balance.'],
    NoPosition: ['Nothing to claim', 'This wallet has no stake to claim in this pool.'],
  };
  const [title, body] = (errorName && words[errorName]) ?? [w.failTitle, `Monad would turn the ${w.noun} down${errorName ? ` (${errorName})` : ''}.`];
  return failed(title, body, true, close);
}

export function phaseFromOutcome(o: RunOutcome, w: OutcomeWords): ConfirmPhase {
  switch (o.kind) {
    case 'sent':
      return { step: 'done', txHash: o.txHash };
    case 'reverted':
      return failed(w.failTitle, `Monad turned the ${w.noun} down, so it was undone. The pool may have changed; check it and try again.`, true);
    case 'submitted':
      return failed('Still confirming', `Your ${w.noun} was sent, but Monad hasn't confirmed it yet. Check Me in a few minutes before you try again.`, false, checkMe);
    case 'failed_pre_submit':
      return failed(w.failTitle, `The gas sponsor turned it down before it reached Monad.`, true);
    case 'expired':
      return failed('That took too long', `The signed ${w.noun} expired before it was sent.`, true);
    case 'in_progress':
      return failed('Already sending', `This ${w.noun} is already on its way. Check Me in a minute before you try again.`, false, checkMe);
    case 'manual_review':
      return failed('Waiting for a check', `This ${w.noun} is held for a manual check. Don't send it again; check Me later.`, false, checkMe);
    case 'sponsor_failed':
      if (o.status === 429) return failed('Daily limit reached', 'An email account gets 10 gas-free transactions a day. Try again tomorrow.', true, close);
      if (o.status === 409) return failed('Another transaction is still going', 'Wait for your last transaction to finish, then try again.', true);
      if (o.status === 401) return failed('Signed out', 'Sign in again, then try again.', true, { label: 'Sign in', href: '/signup' });
      if (o.status === 403) return failed(w.failTitle, `Mako Market can't cover the gas for this ${w.noun}.`, true, close);
      if (o.status === 0) return failed("Can't reach Mako Market", 'Check your connection and try again.', true);
      return failed(w.failTitle, `Mako Market couldn't prepare it.`, true);
    case 'send_failed':
      if (o.error === 'sign_rejected') return { step: 'cancelled' };
      if (o.error === 'sign_failed') return failed("Couldn't sign", `Your Mako wallet couldn't sign the ${w.noun}.`, true);
      // A refusal from the send route itself (4xx) comes before anything is submitted. A dropped connection or a
      // server error after signing may still have reached Monad.
      if (o.status >= 400 && o.status < 500) return failed(w.failTitle, `Mako Market couldn't send it.`, true);
      return failed('Lost the connection', `Your signed ${w.noun} may still reach Monad. Check Me before you try again.`, false, checkMe);
  }
}
