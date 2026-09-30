// Turning a proven identity into a Mako Market session, for the sign-in dialog (14a). The same requests and the
// same reading of every response as the reviewed /signup page (src/app/signup/page.tsx postAuthToken and
// handleSubmitTotp), gathered here so the dialog and its tests share them.

import { mapTotpResponse, type TotpRequiredState } from '@/components/signup/TotpStep';
import type { AuthedUser } from './use-user';

export type SessionResult =
  /// `firstSignIn`: the account had never signed in before (the route returns lastSignInAt: null only then).
  | { kind: 'signed_in'; user: AuthedUser; firstSignIn: boolean }
  | { kind: 'totp'; challengeId: string }
  /// The identity proof is still valid; the same request can be retried.
  | { kind: 'retry'; message: string }
  | { kind: 'error'; message: string };

/// The success envelope, minus the route's `ok` flag, which must never reach the user cache.
function toUser(body: Record<string, unknown>): AuthedUser {
  const { ok: _ok, status: _status, ...user } = body;
  void _ok;
  void _status;
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

/// POST /api/user/auth with the Privy access token proved by the email code.
export async function exchangePrivyToken(privyAccessToken: string): Promise<SessionResult> {
  let res: Response;
  try {
    res = await fetch('/api/user/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ privyAccessToken }),
    });
  } catch {
    return { kind: 'retry', message: 'Network error. Your code is still good; try again.' };
  }
  if (res.ok) {
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { kind: 'retry', message: 'Unexpected response. Your code is still good; try again.' };
    }
    if (body.status === 'totp_required') return { kind: 'totp', challengeId: typeof body.challengeId === 'string' ? body.challengeId : '' };
    if (body.authed === true) return { kind: 'signed_in', user: toUser(body), firstSignIn: body.lastSignInAt === null };
    return { kind: 'retry', message: 'Unexpected response. Your code is still good; try again.' };
  }
  if (res.status >= 500) return { kind: 'retry', message: 'Server error. Your code is still good; try again.' };
  let error: string | undefined;
  try {
    error = ((await res.json()) as { error?: string }).error;
  } catch {
    error = undefined;
  }
  return { kind: 'error', message: (error && ERRORS[error]) ?? 'Sign-in failed. Please try again.' };
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
  if (body && body.authed === true) return { kind: 'signed_in', user: toUser(body), firstSignIn: body.lastSignInAt === null };
  return { kind: 'state', next: { ...state, submitting: false, error: 'Unexpected response. Please retry.' } };
}
