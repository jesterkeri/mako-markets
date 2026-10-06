// ----------------------------------------------------------------------------
// src/lib/privy-gated-signin.ts
//
// The browser side of the inbox-takeover gate (mako-design INBOX_GAP_PLAN r18). After Privy's email code, the dialog
// asks the server where this user stands and walks the same order the server enforces:
//   1. no authenticator  -> enroll one (Mako's own screen, Privy's headless calls; never Privy's screen with Remove);
//   2. no wallet         -> create it, only after the authenticator: right after enrollment (and at least 1.1 s
//                           after it, so its link time is a later second, [G3]), or behind a fresh code if the user
//                           came back after an interruption ([H2]);
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

/// [G3] The wallet's link time must be a later whole second than the authenticator's: wait this long, on the
/// monotonic clock, after enrollment resolves before creating the wallet.
export const WALLET_AFTER_ENROLL_MS = 1100;

export type GateStep =
  | { kind: 'enroll' }
  | { kind: 'wallet_setup' }
  | { kind: 'session'; result: SessionResult };

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

/// One pass of the gate: where this user stands, and, when the server issues a nonce, the proof and the session.
export async function continueGatedSignIn(bridge: GateBridge, site: string): Promise<GateStep> {
  const token = await bridge.token();
  if (!token) return { kind: 'session', result: { kind: 'error', message: 'Sign-in returned no token. Please try again.' } };

  const step = await postJson('/api/user/auth/proof', { privyAccessToken: token });
  if (!step) return { kind: 'session', result: { kind: 'retry', message: 'Network error. Your code is still good; try again.' } };
  if (step.status >= 500) return { kind: 'session', result: { kind: 'retry', message: GATE_MESSAGES.unavailable } };
  const status = step.json?.status;
  if (status === 'mfa_enrollment_required') return { kind: 'enroll' };
  if (status === 'wallet_required') return { kind: 'wallet_setup' };
  if (status === 'account_locked') return { kind: 'session', result: { kind: 'error', message: GATE_MESSAGES.account_locked } };
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
