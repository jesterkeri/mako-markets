// ----------------------------------------------------------------------------
// src/lib/magic-browser.ts
//
// Browser Magic SDK loader. The SDK touches `window` at construction time, so
// it must never run on the server. We guard with two protections:
//
//   1. Dynamic `await import('magic-sdk')` inside getMagic() — keeps the SDK
//      out of any server-rendered bundle even if a server module accidentally
//      imports this file.
//   2. `typeof window !== 'undefined'` check — refuses to construct the
//      Magic instance during SSR/prerender.
//
// The function returns a singleton per browser tab. Callers should `await
// getMagic()` at interaction time (button click), not at module load — the
// dynamic import would otherwise run during the page's initial hydration and
// pull magic-sdk into the first paint chunk for no benefit.
//
// Magic flavor: Auth, default OTP UI (`showUI: true`). Do not change without
// revisiting Phase 1A scope — see magic-server.ts header.
// ----------------------------------------------------------------------------

import type { Address, Hex } from 'viem';
import type { Magic as MagicInstance } from 'magic-sdk';

import { buildSafeOpEnvelope } from './aa-signature';

let cached: MagicInstance | undefined;

export async function getMagic(): Promise<MagicInstance> {
  if (typeof window === 'undefined') {
    throw new Error('getMagic() must only run in the browser.');
  }
  if (cached) return cached;

  const publishableKey = process.env.NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error(
      'NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY is not set. Add it to .env.local and Vercel env.',
    );
  }

  const { Magic } = await import('magic-sdk');
  cached = new Magic(publishableKey);
  return cached;
}

// ── Safe4337Module signing ──────────────────────────────────────────────────
//
// `signSafeOpHash` is the browser-side bridge between the SafeOp hash
// computed by `safe-op-hash.ts` and the 77-byte envelope expected by
// the Safe4337Module v0.3.0 sig-validation path.
//
// Signing path:
//   1. Magic's RPC provider exposes EIP-1193 `personal_sign`. We call it
//      with `[message, address]` (param order MATTERS — Magic, like most
//      providers, accepts both `[message, address]` and
//      `[address, message]` but only the documented order is portable).
//   2. The provider returns a 65-byte raw secp256k1 signature in
//      `r || s || v` form. Magic returns canonical v ∈ {27, 28} but
//      `aa-signature.normalizeEcdsaV` accepts `0/1/27/28` and rejects
//      EIP-155 chain-prefixed values defensively.
//   3. `buildSafeOpEnvelope` prepends `validAfter || validUntil` (12
//      bytes BE) and bumps the v byte by +4 to mark this as the Safe
//      `eth_sign` envelope (Safe.checkSignatures undoes the +4 and
//      re-applies the EIP-191 prefix internally).
//
// Magic may display the raw SafeOp hash hex in its prompt; custom
// signing UI (e.g., decoded "this op transfers X USDC to Y") is out of
// scope for Phase 1B.
//
// Returns the 77-byte envelope ready to POST to /api/aa/send.

type Eip1193Provider = {
  request(args: { method: string; params: unknown[] }): Promise<unknown>;
};

export async function signSafeOpHash(args: {
  hash: Hex;
  magicEoa: Address;
  validAfter: bigint;
  validUntil: bigint;
}): Promise<Hex> {
  if (typeof window === 'undefined') {
    throw new Error('signSafeOpHash() must only run in the browser.');
  }

  const magic = await getMagic();

  // `magic.rpcProvider` is typed loosely on the SDK side; cast to the
  // EIP-1193 shape we actually use.
  const provider = magic.rpcProvider as unknown as Eip1193Provider;
  const raw = await provider.request({
    method: 'personal_sign',
    // `[message, address]` order. Magic SDK's RPC provider is
    // case-insensitive on `address` but normalize anyway for clarity.
    params: [args.hash, args.magicEoa.toLowerCase()],
  });

  if (typeof raw !== 'string' || !raw.startsWith('0x')) {
    throw new Error(
      `signSafeOpHash: Magic returned non-hex signature: ${typeof raw}`,
    );
  }

  return buildSafeOpEnvelope({
    rawSignature: raw as Hex,
    validAfter: args.validAfter,
    validUntil: args.validUntil,
  });
}

// ── Email change (Phase 1E) ─────────────────────────────────────────────────
//
// Magic Web SDK's `magic.auth.updateEmailWithUI({ email })` opens Magic's
// own modal at the new email address, asks for OTP confirmation, and on
// success rotates the email mapping in Magic's backend. The Magic-derived
// EOA does NOT change — Path X invariant holds and the Safe address stays
// the same.
//
// AVAILABILITY CAVEAT (the gating pre-flight check):
// Magic docs tag this method as "Dedicated Wallet" only. Mako runs Magic
// Auth flavor (see magic-server.ts header). At call time we may discover
// the method is undefined or throws a product-not-supported error. The
// browser wrapper detects both cases and surfaces a stable
// `EmailUpdateNotSupported` error so the caller can fall back to recovery
// copy without crashing.
//
// On success, the wrapper returns a fresh DID token (via getIdToken)
// which the caller posts to /api/user/email/update. The route validates
// the DID server-side and updates users.email atomically.

export class EmailUpdateNotSupported extends Error {
  constructor() {
    super('Magic Auth flavor does not support updateEmailWithUI in this app.');
    this.name = 'EmailUpdateNotSupported';
  }
}

/// Update the user's email via Magic's modal flow, then return a fresh
/// DID token bound to the (still-same) public address. Throws
/// `EmailUpdateNotSupported` if the SDK doesn't expose the method in
/// the current Magic product configuration.
///
/// Note: `magic.auth.updateEmailWithUI` is the documented method name
/// per the Magic Web SDK. Earlier comments in the codebase referenced
/// `magic.user.updateEmail` — that namespace is incorrect and was
/// caught during integration review.
export async function updateEmailWithMagic(args: {
  newEmail: string;
}): Promise<{ didToken: string }> {
  if (typeof window === 'undefined') {
    throw new Error('updateEmailWithMagic() must only run in the browser.');
  }

  const magic = await getMagic();

  // Defensive: SDK shape may not expose the method on Auth flavor. Probe
  // the function's existence before calling so we surface a typed error
  // instead of a generic TypeError.
  const auth = (magic as unknown as { auth?: Record<string, unknown> }).auth;
  const method =
    auth && typeof auth.updateEmailWithUI === 'function'
      ? (auth.updateEmailWithUI as (
          args: Record<string, unknown>,
        ) => Promise<unknown>)
      : null;
  if (!method) {
    throw new EmailUpdateNotSupported();
  }

  try {
    await method.call(auth, { email: args.newEmail });
  } catch (e) {
    // Magic SDK errors that signal "not supported in this product
    // configuration" are surfaced as our typed sentinel. Unknown errors
    // pass through unchanged so callers can show specific messages.
    const msg = e instanceof Error ? e.message : '';
    if (
      /not supported/i.test(msg) ||
      /not available/i.test(msg) ||
      /dedicated/i.test(msg)
    ) {
      throw new EmailUpdateNotSupported();
    }
    throw e;
  }

  // Fetch a fresh DID token AFTER the email change. Don't rely on
  // implicit refresh: explicit getIdToken() guarantees the token's
  // attached email claim reflects the new value (Codex review note).
  const didToken = await magic.user.getIdToken();
  if (!didToken || typeof didToken !== 'string') {
    throw new Error('updateEmailWithMagic: getIdToken returned non-string');
  }
  return { didToken };
}
