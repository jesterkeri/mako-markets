// The one place the app signs a sponsored Safe operation with the account's embedded signer.
//
// Every email account's Safe has a single owner: an embedded EOA the user never manages. That signer is a
// Privy embedded wallet (Magic until 2026-09; Joshua moved everyone to Privy on 2026-09-29, keeping Mako's own
// Safe4337 + Pimlico sponsorship and its server-side controls). A React bridge registers the wallet here once
// Privy has it ready; aa-client calls `signSafeOpHash`, which never needs to know which provider signs.
//
// The field is still called `magicEoa` across the codebase and the database (`users.magic_eoa`): it is the
// embedded signer's address, whatever provides it. Renaming it touches about 80 files and a migration.
//
// Signing (unchanged from the Magic signer): EIP-191 `personal_sign` over the 32-byte SafeOp hash, then
// `buildSafeOpEnvelope` prepends validAfter || validUntil and bumps v by 4, the Safe `eth_sign` envelope.

import type { Address, Hex } from 'viem';

import { buildSafeOpEnvelope } from './aa-signature';

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

interface Signer {
  address: Address;
  provider: Eip1193Provider;
}

interface Waiter {
  resolve(s: Signer): void;
  reject(e: Error): void;
}

let active: Signer | null = null;
/// Set when the bridge knows no signer is coming: the account's wallet is not in this sign-in ('missing'), or
/// Privy failed to hand it over ('unavailable').
let failure: 'missing' | 'unavailable' | null = null;
let waiters: Waiter[] = [];
/// Bumped by every sign-out. A signing operation remembers the value it started under and is cancelled if it
/// changes, so nothing started before a sign-out completes after it.
let signInGeneration = 0;

/// Called by the Privy bridge when the embedded wallet that owns this account is ready (and again if it
/// changes). The bridge registers only the wallet whose address is the account's signer.
export function registerEmbeddedSigner(address: Address, provider: Eip1193Provider): void {
  active = { address, provider };
  failure = null;
  const ready = waiters;
  waiters = [];
  for (const w of ready) w.resolve(active);
}

/// Called on logout, or when the sign-in ends. Sign-out is the user's cancellation boundary (Codex T2.2 r3): an
/// operation waiting for the wallet is refused now rather than resumed by the next sign-in to the same
/// account, and one already being signed is refused when its signature returns. An operation started after
/// this waits for the next sign-in as usual.
export function clearEmbeddedSigner(): void {
  active = null;
  failure = null;
  signInGeneration += 1;
  const pending = waiters;
  waiters = [];
  for (const w of pending) w.reject(new EmbeddedSignerCancelled());
}

/// Called by the bridge when Privy's wallets have loaded but none is the account's signer: signing fails at
/// once with a clear message instead of waiting for a wallet that will not come.
export function markEmbeddedSignerMissing(): void {
  fail('missing');
}

/// Called by the bridge when Privy lists the account's wallet but could not give us its provider (Codex T2.2
/// r2: this used to leave every signature waiting 15 seconds for a wallet that would not load).
export function markEmbeddedSignerUnavailable(): void {
  fail('unavailable');
}

function fail(kind: 'missing' | 'unavailable'): void {
  active = null;
  failure = kind;
  // A signature already waiting gets the same answer now, not a "still loading" timeout later.
  const pending = waiters;
  waiters = [];
  for (const w of pending) w.reject(failureError(kind));
}

function failureError(kind: 'missing' | 'unavailable'): Error {
  return kind === 'missing' ? new EmbeddedSignerMissing() : new EmbeddedSignerUnavailable();
}

export class EmbeddedSignerMissing extends Error {
  constructor() {
    super(
      "The wallet that owns this account isn't available in this sign-in. Sign out and sign in again with the same email; if it keeps happening, contact support.",
    );
    this.name = 'EmbeddedSignerMissing';
  }
}

/// Privy has the account's wallet but failed to load it (for example its iframe did not start). Reloading the
/// page mounts the bridge again, which asks Privy again.
export class EmbeddedSignerUnavailable extends Error {
  constructor() {
    super("Your wallet couldn't be loaded. Reload the page and try again; if it keeps happening, sign out and sign in again.");
    this.name = 'EmbeddedSignerUnavailable';
  }
}

/// The sign-in ended while this operation was waiting for the wallet or being signed.
export class EmbeddedSignerCancelled extends Error {
  constructor() {
    super('Your sign-in changed before this could be signed, so it was cancelled. Please try again.');
    this.name = 'EmbeddedSignerCancelled';
  }
}

export class EmbeddedSignerNotReady extends Error {
  constructor() {
    super('Your wallet is still loading. Please try again in a moment.');
    this.name = 'EmbeddedSignerNotReady';
  }
}

/// The wallet ready to sign is not this account's owner. Refused: a signature from any other key would be
/// rejected by the Safe anyway, and signing with the wrong wallet is how an account ends up confused about
/// which Safe it owns (Moray, 2026-07: "same email, 2 wallets").
export class EmbeddedSignerMismatch extends Error {
  constructor() {
    super('The wallet signed in on this device is not the one that owns this account. Sign out and sign in again.');
    this.name = 'EmbeddedSignerMismatch';
  }
}

/// Privy loads the embedded wallet asynchronously after sign-in, so a first bet can arrive before it is ready.
const READY_TIMEOUT_MS = 15_000;

async function readySigner(): Promise<Signer> {
  if (active) return active;
  if (failure) throw failureError(failure);
  return new Promise<Signer>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== waiter);
      reject(new EmbeddedSignerNotReady());
    }, READY_TIMEOUT_MS);
    const waiter: Waiter = {
      resolve: (s) => {
        clearTimeout(timer);
        resolve(s);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    waiters.push(waiter);
  });
}

export async function signSafeOpHash(args: {
  hash: Hex;
  magicEoa: Address;
  validAfter: bigint;
  validUntil: bigint;
}): Promise<Hex> {
  if (typeof window === 'undefined') {
    throw new Error('signSafeOpHash() must only run in the browser.');
  }
  const generation = signInGeneration;
  const signer = await readySigner();
  if (signer.address.toLowerCase() !== args.magicEoa.toLowerCase()) throw new EmbeddedSignerMismatch();

  const raw = await signer.provider.request({
    method: 'personal_sign',
    params: [args.hash, signer.address.toLowerCase()],
  });
  if (signInGeneration !== generation) throw new EmbeddedSignerCancelled();
  if (typeof raw !== 'string' || !raw.startsWith('0x')) {
    throw new Error(`signSafeOpHash: the wallet returned a non-hex signature: ${typeof raw}`);
  }
  return buildSafeOpEnvelope({ rawSignature: raw as Hex, validAfter: args.validAfter, validUntil: args.validUntil });
}
