// ----------------------------------------------------------------------------
// src/lib/privy-gated-signin.ts
//
// The browser side of the inbox-takeover gate (mako-design INBOX_GAP_PLAN r18). After Privy's email code, the dialog
// asks the server where this user stands and walks the same order the server enforces:
//   1. no authenticator  -> enroll one (Mako's own screen, Privy's headless calls; never Privy's screen with Remove);
//   2. no wallet         -> create it, only after the authenticator AND only after the server answered
//                           `wallet_required`, which is when it records the enrollment checkpoint (migration 0014):
//                           right after enrollment, or behind a fresh code if the user came back after an
//                           interruption ([H2]). A wallet created before that answer would fail the first admission;
//   3. a sign-in proof   -> the embedded wallet signs a message THIS code builds (site, server nonce, time); Privy asks
//                           the authenticator first, so the signature shows the factor was passed now ([B2]);
//   4. the session       -> POST /api/user/auth with the proof.
// Privy is reached only through the injected `GateBridge`, so this file is testable without a browser.
// ----------------------------------------------------------------------------

import { buildProofMessage, PROOF_NONCE_RE } from '@/lib/privy-proof-message';
import { GATE_MESSAGES, mapSessionResponse, type SessionResult } from '@/lib/session-exchange';

export { GATE_MESSAGES };

/// The Privy operations the gate needs, provided by PrivyEmailBridge (inside Privy's provider).
export interface GateBridge {
  /// The current Privy access token (refreshed by Privy as needed).
  token(): Promise<string | null>;
  enrollStart(): Promise<{ secret: string; authUrl: string }>;
  /// Completes enrollment; resolves once Privy has recorded the authenticator.
  enrollFinish(code: string): Promise<void>;
  /// Asks a fresh authenticator code, clearing any earlier verification first.
  freshFactor(): Promise<void>;
  /// Creates the single embedded Ethereum wallet; resolves to its address.
  createWallet(): Promise<string>;
  /// The user's embedded Ethereum wallet address, once Privy has loaded it; null if there is none.
  embeddedAddress(): string | null;
  /// personal_sign by that wallet over `message`, after clearing any earlier verification (Privy asks the code).
  signProof(message: string, address: string): Promise<string>;
}

export type GateStep =
  | { kind: 'enroll' }
  | { kind: 'wallet_setup' }
  | { kind: 'session'; result: SessionResult };

/// Why a fresh email code is needed (remembered browsers, SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2).
export type EmailReason = 'too_late' | 'other_device' | 'not_confirmed';

/// Step A's answer, kept so the dialog can say why if the server later asks for the email again.
export type StepAResult = { ok: true } | { ok: false; reason: EmailReason };

const REASONS: ReadonlyArray<EmailReason> = ['too_late', 'other_device', 'not_confirmed'];
export const emailReasonOf = (v: unknown): EmailReason => (REASONS.includes(v as EmailReason) ? (v as EmailReason) : 'not_confirmed');

/// /api/user/auth/email-start, right before the code is sent: this browser's email ceremony (an httpOnly cookie). A
/// failure is not fatal: the server's own check at sign-in decides, and it never admits anything weaker.
export async function startEmailCeremony(): Promise<void> {
  await postJson('/api/user/auth/email-start', {});
}

/// Step A: called right after loginWithCode with the FIRST token after it, retried with that same token when the
/// answer was lost (a network error or a server error); a definite refusal is final.
export async function recordEmailVerification(token: string, attempts = 3): Promise<StepAResult> {
  for (let i = 0; i < attempts; i++) {
    const r = await postJson('/api/user/auth/email-verified', { privyAccessToken: token });
    if (r && r.status < 500 && r.json) {
      if (r.json.ok === true) return { ok: true };
      return { ok: false, reason: emailReasonOf(r.json.reason) };
    }
  }
  return { ok: false, reason: 'not_confirmed' };
}

/// Before any authenticator prompt: may this Privy session go on without a new email code? `off`: the feature is off
/// (an email code every time, as before). Anything unreadable counts as `email_needed`.
export type ShortcutStatus = 'shortcut' | 'bind_possible' | 'rebind' | 'email_needed' | 'off';
export async function checkShortcut(bridge: GateBridge): Promise<ShortcutStatus> {
  const token = await bridge.token();
  if (!token) return 'email_needed';
  const r = await postJson('/api/user/auth/shortcut-check', { privyAccessToken: token });
  const s = r?.json?.status;
  return s === 'shortcut' || s === 'bind_possible' || s === 'rebind' || s === 'off' ? s : 'email_needed';
}

async function postJson(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null } | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch {
    return null;
  }
}

/// One pass of the gate: where this user stands, and, when the server issues a nonce, the proof and the session. A
/// proof that expired on the way (`proof_expired`) is retried once with a fresh nonce (SIGNIN_REMEMBERED_BROWSER_PLAN
/// r29 2.2); a device clock too far ahead (`clock_skew`) is never retried.
export async function continueGatedSignIn(bridge: GateBridge, site: string): Promise<GateStep> {
  const first = await gatePass(bridge, site);
  if (first.kind === 'session' && first.result.kind === 'proof_expired') return gatePass(bridge, site);
  return first;
}

async function gatePass(bridge: GateBridge, site: string): Promise<GateStep> {
  const token = await bridge.token();
  if (!token) return { kind: 'session', result: { kind: 'error', message: 'Sign-in returned no token. Please try again.' } };

  const step = await postJson('/api/user/auth/proof', { privyAccessToken: token });
  if (!step) return { kind: 'session', result: { kind: 'retry', message: 'Network error. Your code is still good; try again.' } };
  if (step.status >= 500) return { kind: 'session', result: { kind: 'retry', message: GATE_MESSAGES.unavailable } };
  const status = step.json?.status;
  if (status === 'mfa_enrollment_required') return { kind: 'enroll' };
  if (status === 'wallet_required') return { kind: 'wallet_setup' };
  if (status === 'account_locked') {
    const offer = step.json?.startOver === true;
    return { kind: 'session', result: { kind: 'error', message: offer ? START_OVER_MESSAGE : GATE_MESSAGES.account_locked, ...(offer ? { startOver: true as const } : {}) } };
  }
  const nonce = step.json?.nonce;
  if (status !== 'proof_required' || typeof nonce !== 'string' || !PROOF_NONCE_RE.test(nonce)) {
    // A nonce of any other shape is refused: the wallet signs only the frame this file builds ([B2]).
    return { kind: 'session', result: mapSessionResponse(step.status, step.json) };
  }

  const address = bridge.embeddedAddress();
  if (!address) return { kind: 'session', result: { kind: 'retry', message: 'Your wallet is still loading. Try again in a moment.' } };
  const message = buildProofMessage(site, nonce, new Date());
  let signature: string;
  try {
    signature = await bridge.signProof(message, address);
  } catch {
    return { kind: 'session', result: { kind: 'retry', message: GATE_MESSAGES.proof_cancelled } };
  }

  const auth = await postJson('/api/user/auth', { privyAccessToken: token, proof: { message, signature } });
  if (!auth) return { kind: 'session', result: { kind: 'retry', message: 'Network error. Your code is still good; try again.' } };
  return { kind: 'session', result: mapSessionResponse(auth.status, auth.json) };
}

/// The enrollment checkpoint, asked for right before a wallet is created (migration 0014), and ONLY right after this
/// browser passed the authenticator (finished enrolling it, or entered a fresh code): the server records a checkpoint
/// only on this request, so the authenticator it saw is the one this browser just proved. Only the server's
/// `wallet_required` answer means it recorded the checkpoint (an authenticator, no wallet on any chain); only then may
/// the wallet be created. Any other answer means do not create one: `retry` for a network or server failure, otherwise
/// the caller runs the gate again to show where the user stands.
export async function confirmWalletFree(bridge: GateBridge): Promise<{ ok: true } | { ok: false; retry: boolean }> {
  const token = await bridge.token();
  if (!token) return { ok: false, retry: true };
  const step = await postJson('/api/user/auth/proof', { privyAccessToken: token, checkpoint: true });
  if (!step || step.status >= 500) return { ok: false, retry: true };
  return step.json?.status === 'wallet_required' ? { ok: true } : { ok: false, retry: false };
}

/// What a locked account that never completed its first sign-in is told: it can start over, and why that is safe.
export const START_OVER_MESSAGE =
  'This sign-up never finished, so it can’t be unlocked. Start over to set it up again with a new authenticator and a new account. Nothing was deposited to it.';

/// Self-service Start over (src/lib/start-over.ts): asks the server to clear the unfinished sign-up. The server re-checks
/// every condition and deletes nothing unless all hold.
export async function startOver(bridge: GateBridge): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = await bridge.token();
  if (!token) return { ok: false, message: 'Sign-in returned no token. Please try again.' };
  const r = await postJson('/api/user/auth/start-over', { privyAccessToken: token });
  if (r && r.status === 200 && r.json?.ok === true) return { ok: true };
  if (r?.json?.status === 'finish_elsewhere') return { ok: false, message: 'Finish signing in in the browser where you set up your authenticator.' };
  if (r?.json?.status === 'admitted') return { ok: false, message: GATE_MESSAGES.account_locked };
  return { ok: false, message: 'Starting over didn’t work just now. Try again shortly.' };
}
