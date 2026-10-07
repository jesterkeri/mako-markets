// Turning a proven identity into a Mako Market session, for the sign-in dialog (14a). The same requests and the
// same reading of every response as the reviewed /signup page (src/app/signup/page.tsx postAuthToken and
// handleSubmitTotp), gathered here so the dialog and its tests share them.

import { mapTotpResponse, type TotpRequiredState } from '@/components/signup/TotpStep';
import type { AuthedUser } from './use-user';

export type SessionResult =
  /// `firstSignIn`: this sign-in created the account, exactly as the route says (`firstSignIn`). Never inferred from
  /// "no earlier session": signing out deletes sessions (live test and adversary on 454c020, 2026-10-07).
  | { kind: 'signed_in'; user: AuthedUser; firstSignIn: boolean }
  | { kind: 'totp'; challengeId: string }
  /// The identity proof is still valid; the same request can be retried.
  | { kind: 'retry'; message: string }
  /// `startOver`: a locked account that never completed its first sign-in, which the server offers to start over.
  | { kind: 'error'; message: string; startOver?: true };

/// The success envelope, minus the route's `ok` flag, which must never reach the user cache.
function toUser(body: Record<string, unknown>): AuthedUser {
  // firstSignIn is about this sign-in, not the account: it never goes into the cached user.
  const { ok: _ok, status: _status, firstSignIn: _first, ...user } = body;
  void _ok;
  void _status;
  void _first;
  return user as unknown as AuthedUser;
}

const ERRORS: Record<string, string> = {
  not_allowlisted: 'This email is not on the beta list yet.',
  identity_conflict: 'This email belongs to an account with a different wallet, so sign-in stopped to keep it safe.',
  bad_token: 'The sign-in code expired. Ask for a new one.',
  no_email: 'Your sign-in did not finish setting up. Please try again.',
  no_embedded_wallet: 'Your sign-in did not finish setting up. Please try again.',
  cross_origin: 'The request was blocked by a security check. Refresh the page and try again.',
};

/// The inbox-takeover gate's refusals (INBOX_GAP_PLAN r18), in plain language. No em dashes, no "we/our/us".
export const GATE_MESSAGES = {
  account_locked:
    "This account can't be unlocked from here, to keep its funds safe. Contact support from the email address you signed up with. Support never unlocks an account because of an email request alone.",
  email_changed:
    "The sign-in email for this account was changed at Mako Market's login provider, Privy, so Mako Market has locked the account. While it is locked, Mako Market will not sign it in, act with its wallet or show its deposit address, and support will not change it because of an email request. If you saved a copy of your wallet key, that copy works outside Mako Market, so keep it safe. Contact support from the email address you signed up with.",
  mfa_proof_required: "The authenticator check didn't finish, so you're not signed in. Try again.",
  proof_cancelled: 'Sign-in needs the code from your authenticator app. Try again when you have it.',
  unavailable: 'Sign-in is unavailable for a moment. Try again shortly.',
} as const;

/// Any answer from POST /api/user/auth (or a refusal from /api/user/auth/proof) as the dialog's next step.
export function mapSessionResponse(status: number, body: Record<string, unknown> | null): SessionResult {
  if (status >= 500) return { kind: 'retry', message: body?.error === 'privy_unavailable' ? GATE_MESSAGES.unavailable : 'Server error. Your code is still good; try again.' };
  if (!body) return { kind: 'retry', message: 'Unexpected response. Your code is still good; try again.' };
  if (status === 200 && body.status === 'totp_required') return { kind: 'totp', challengeId: typeof body.challengeId === 'string' ? body.challengeId : '' };
  if (status === 200 && body.authed === true) {
    return { kind: 'signed_in', user: toUser(body), firstSignIn: body.firstSignIn === true };
  }
  if (body.status === 'account_locked') return { kind: 'error', message: GATE_MESSAGES.account_locked };
  if (body.status === 'email_changed') return { kind: 'error', message: GATE_MESSAGES.email_changed };
  if (body.status === 'mfa_proof_required') return { kind: 'retry', message: GATE_MESSAGES.mfa_proof_required };
  const error = typeof body.error === 'string' ? body.error : undefined;
  if (status >= 400) return { kind: 'error', message: (error && ERRORS[error]) ?? 'Sign-in failed. Please try again.' };
  return { kind: 'retry', message: 'Unexpected response. Your code is still good; try again.' };
}

export type TotpResult = { kind: 'signed_in'; user: AuthedUser; firstSignIn: boolean } | { kind: 'state'; next: TotpRequiredState };

/// POST /api/user/auth/totp with an authenticator or recovery code. Every failure reading comes from
/// mapTotpResponse, the reviewed mapper.
export async function submitTotp(state: TotpRequiredState, code: string): Promise<TotpResult> {
  let res: Response;
  try {
    res = await fetch('/api/user/auth/totp', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.mode === 'totp' ? { challengeId: state.challengeId, code } : { challengeId: state.challengeId, recoveryCode: code }),
    });
  } catch {
    return { kind: 'state', next: { ...state, submitting: false, error: 'Network error. Please retry.' } };
  }
  let body: (Record<string, unknown> & { error?: string; retryAt?: string }) | null = null;
  try {
    body = (await res.json()) as Record<string, unknown> & { error?: string; retryAt?: string };
  } catch {
    if (res.ok) return { kind: 'state', next: { ...state, submitting: false, error: 'Unexpected response. Please retry.' } };
  }
  const outcome = mapTotpResponse(state, res.status, body);
  if (outcome.kind === 'state') return outcome;
  if (body && body.authed === true) return { kind: 'signed_in', user: toUser(body), firstSignIn: body.firstSignIn === true };
  return { kind: 'state', next: { ...state, submitting: false, error: 'Unexpected response. Please retry.' } };
}
