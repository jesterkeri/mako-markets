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
