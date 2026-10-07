// ----------------------------------------------------------------------------
// src/lib/start-over.ts
//
// Self-service Start over (Codex SIGNIN_R1 A1; owner decision 2026-10-07). An account that never completed its first
// sign-in can be locked for good: e.g. its wallet was created, the first sign-in did not finish, and the browser's
// enrollment checkpoint expired (no new one can be issued once a wallet exists). Such an identity has no Mako account
// and nothing deposited (the deposit address is shown only after sign-in), so deleting the unfinished Privy user and
// letting the person sign up fresh, with a new wallet made after their own authenticator, loses nothing and gives an
// inbox-only attacker nothing they could not already do (start a fresh sign-up); it also removes a wallet they planted.
//
// NOT the "sign with the current wallet" recovery the review suggested: a Privy wallet signs for whoever holds the
// session and the current authenticator, so an owner facing an attacker-made wallet could sign with it and be admitted.
//
// Eligible only when ALL hold, each re-checked by the server from its own reads:
//   1. the gate's verdict for this read is account_locked;
//   2. no Mako account is bound to this Privy user (never admitted; an account that ever signed in is never eligible);
//   3. no email-moved conflict (C4 keeps its own handling);
//   4. no browser holds an unexpired checkpoint for this Privy user (it could still finish there).
// Rules 2 and 4 alone do not stop a first admission already in flight (adversary on 5c8d81c): the route re-checks them
// under lockPrivyUser, the lock that first admission holds until it commits, on the database's clock after the wait,
// then commits a Start over FENCE before the Privy delete (Codex SIGNIN_R2 B1), since the lock ends with its
// transaction and a remote delete may outlive it.
// ----------------------------------------------------------------------------

export interface StartOverFacts {
  verdictStatus: 'ok' | 'account_locked' | 'mfa_enrollment_required' | 'wallet_required';
  boundToAccount: boolean;
  emailMoved: boolean;
  liveCheckpoint: boolean;
}

export type StartOverDecision = { eligible: true } | { eligible: false; reason: 'not_locked' | 'admitted' | 'email_changed' | 'finish_elsewhere' };

export function startOverDecision(f: StartOverFacts): StartOverDecision {
  if (f.emailMoved) return { eligible: false, reason: 'email_changed' };
  if (f.boundToAccount) return { eligible: false, reason: 'admitted' };
  if (f.verdictStatus !== 'account_locked') return { eligible: false, reason: 'not_locked' };
  if (f.liveCheckpoint) return { eligible: false, reason: 'finish_elsewhere' };
  return { eligible: true };
}
