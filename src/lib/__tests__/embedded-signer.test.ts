// The embedded-signer seam: signs only with the account's own wallet, waits for the wallet to load, and
// produces exactly the Safe envelope the Magic signer produced.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

import { buildSafeOpEnvelope } from '../aa-signature';
import {
  clearEmbeddedSigner,
  EmbeddedSignerMismatch,
  EmbeddedSignerNotReady,
  registerEmbeddedSigner,
  signSafeOpHash,
} from '../embedded-signer';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const HASH = ('0x' + 'ab'.repeat(32)) as Hex;
// A 65-byte signature shape (r || s || v=27).
const RAW = ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as Hex;
const args = { hash: HASH, magicEoa: OWNER, validAfter: 0n, validUntil: 1_900_000_000n };

function provider() {
  const calls: { method: string; params?: unknown[] }[] = [];
  return {
    calls,
    request: async (a: { method: string; params?: unknown[] }) => {
      calls.push(a);
      return RAW;
    },
  };
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {};
  clearEmbeddedSigner();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe('embedded signer', () => {
  it('signs with personal_sign over the SafeOp hash and returns the same envelope the Magic signer built', async () => {
    const p = provider();
    registerEmbeddedSigner(OWNER, p);
    const sig = await signSafeOpHash(args);
    expect(p.calls).toEqual([{ method: 'personal_sign', params: [HASH, OWNER.toLowerCase()] }]);
    expect(sig).toBe(buildSafeOpEnvelope({ rawSignature: RAW, validAfter: 0n, validUntil: 1_900_000_000n }));
  });

  it('refuses when the ready wallet is not the account owner, without asking it to sign', async () => {
    const p = provider();
    registerEmbeddedSigner(OTHER, p);
    await expect(signSafeOpHash(args)).rejects.toBeInstanceOf(EmbeddedSignerMismatch);
    expect(p.calls).toEqual([]);
  });

  it('matches the owner whatever the address case', async () => {
    registerEmbeddedSigner(OWNER.toUpperCase().replace('0X', '0x') as Address, provider());
    await expect(signSafeOpHash(args)).resolves.toMatch(/^0x/);
  });

  it('waits for the wallet to load after sign-in', async () => {
    const p = provider();
    const pending = signSafeOpHash(args);
    registerEmbeddedSigner(OWNER, p);
    await expect(pending).resolves.toMatch(/^0x/);
  });

  it('gives up with a clear error if the wallet never loads', async () => {
    vi.useFakeTimers();
    const pending = signSafeOpHash(args);
    const assertion = expect(pending).rejects.toBeInstanceOf(EmbeddedSignerNotReady);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('signs nothing after logout clears the wallet', async () => {
    registerEmbeddedSigner(OWNER, provider());
    clearEmbeddedSigner();
    vi.useFakeTimers();
    const assertion = expect(signSafeOpHash(args)).rejects.toBeInstanceOf(EmbeddedSignerNotReady);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});
