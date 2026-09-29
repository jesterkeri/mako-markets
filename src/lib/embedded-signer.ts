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

let active: Signer | null = null;
let missing = false;
let waiters: ((s: Signer) => void)[] = [];

/// Called by the Privy bridge when the embedded wallet that owns this account is ready (and again if it
/// changes). The bridge registers only the wallet whose address is the account's signer.
export function registerEmbeddedSigner(address: Address, provider: Eip1193Provider): void {
  active = { address, provider };
  missing = false;
  const ready = waiters;
  waiters = [];
  for (const w of ready) w(active);
}

/// Called on logout, or when the embedded wallet goes away.
export function clearEmbeddedSigner(): void {
  active = null;
  missing = false;
}

/// Called by the bridge when Privy's wallets have loaded but none is the account's signer: signing fails at
/// once with a clear message instead of waiting for a wallet that will not come.
export function markEmbeddedSignerMissing(): void {
  active = null;
  missing = true;
}

export class EmbeddedSignerMissing extends Error {
  constructor() {
    super(
      "The wallet that owns this account isn't available in this sign-in. Sign out and sign in again with the same email; if it keeps happening, contact support.",
    );
    this.name = 'EmbeddedSignerMissing';
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
  if (missing) throw new EmbeddedSignerMissing();
  return new Promise<Signer>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== onReady);
      reject(new EmbeddedSignerNotReady());
    }, READY_TIMEOUT_MS);
    const onReady = (s: Signer) => {
      clearTimeout(timer);
      resolve(s);
    };
    waiters.push(onReady);
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
  const signer = await readySigner();
  if (signer.address.toLowerCase() !== args.magicEoa.toLowerCase()) throw new EmbeddedSignerMismatch();

  const raw = await signer.provider.request({
    method: 'personal_sign',
    params: [args.hash, signer.address.toLowerCase()],
  });
  if (typeof raw !== 'string' || !raw.startsWith('0x')) {
    throw new Error(`signSafeOpHash: the wallet returned a non-hex signature: ${typeof raw}`);
  }
  return buildSafeOpEnvelope({ rawSignature: raw as Hex, validAfter: args.validAfter, validUntil: args.validUntil });
}
