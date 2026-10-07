import 'server-only';
// ----------------------------------------------------------------------------
// src/lib/privy-server.ts
//
// Server-side Privy client. Used only by the auth route to verify the access
// token minted by the browser Privy SDK and read the canonical identity for the
// authenticated user: their verified email and their Privy embedded Ethereum
// wallet(s). Replaces magic-server.ts (Joshua, 2026-09-29: everyone moves to
// Privy; Privy's embedded wallet owns each user's Safe, and Mako keeps its own
// Safe4337 + Pimlico sponsorship and its server-side controls).
//
// Trust model (two calls, in order):
//   1. utils().auth().verifyAccessToken(token)
//        Verifies the token's signature, issuer, audience (our app id) and
//        expiry. Throws on anything wrong. Only after this is the user id real.
//   2. users()._get(userId)
//        Reads the user from Privy's API with our app secret. The email and the
//        wallet address come from HERE, never from anything the browser sent.
// ----------------------------------------------------------------------------

import { PrivyClient } from '@privy-io/node';

import { embeddedWallets, judgeFactors, judgePrivyUser, type EnrollmentCheckpoint, type GateAdmission, type GateUser, type GateVerdict, type GateWallet } from '@/lib/privy-gate';
import { normalizeEmail } from '@/lib/email';

/// A deploy/config problem (missing app id or secret): the route answers 500,
/// not "your token is invalid", so the misconfiguration is visible in logs.
export class PrivyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivyConfigError';
  }
}

/// The token was valid but the Privy user is not a usable Mako email account.
export class PrivyIdentityError extends Error {
  constructor(public readonly reason: 'no_email' | 'no_embedded_wallet') {
    super(`PRIVY_IDENTITY: ${reason}`);
    this.name = 'PrivyIdentityError';
  }
}

let cached: PrivyClient | undefined;
function privy(): PrivyClient {
  if (cached) return cached;
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId) throw new PrivyConfigError('NEXT_PUBLIC_PRIVY_APP_ID is not set.');
  if (!appSecret) throw new PrivyConfigError('PRIVY_APP_SECRET is not set.');
  // Without a pinned verification key the client fetches the app's JWKS from
  // Privy; PRIVY_JWT_VERIFICATION_KEY (dashboard) pins it and saves the fetch.
  const jwtVerificationKey = process.env.PRIVY_JWT_VERIFICATION_KEY?.trim() || undefined;
  cached = new PrivyClient({ appId, appSecret, jwtVerificationKey });
  return cached;
}

export interface PrivyIdentity {
  privyUserId: string;
  email: string;
  /// Every Privy embedded Ethereum wallet this user has, lowercase, lowest
  /// wallet index first. Imported keys are excluded: only wallets Privy made.
  wallets: string[];
}

type LinkedAccount = {
  type: string;
  address?: string;
  chain_type?: string;
  connector_type?: string;
  wallet_client_type?: string;
  imported?: boolean;
  wallet_index?: number;
};

/// Pure: the identity inside a Privy user object. Exported for tests.
export function identityFromPrivyUser(user: { id: string; linked_accounts: LinkedAccount[] }): PrivyIdentity {
  const email = user.linked_accounts.find((a) => a.type === 'email' && typeof a.address === 'string')?.address;
  if (!email) throw new PrivyIdentityError('no_email');
  const wallets = user.linked_accounts
    .filter(
      (a) =>
        a.type === 'wallet' &&
        a.wallet_client_type === 'privy' &&
        a.connector_type === 'embedded' &&
        a.chain_type === 'ethereum' &&
        a.imported !== true &&
        typeof a.address === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(a.address),
    )
    .sort((a, b) => (a.wallet_index ?? 0) - (b.wallet_index ?? 0))
    .map((a) => (a.address as string).toLowerCase());
  if (wallets.length === 0) throw new PrivyIdentityError('no_embedded_wallet');
  return { privyUserId: user.id, email, wallets };
}

/**
 * Verify a Privy access token and return the user's canonical identity.
 * Throws PrivyConfigError (500), PrivyIdentityError (409/422), or anything
 * else for an invalid token (401).
 */
export async function verifyPrivyLogin(accessToken: string): Promise<PrivyIdentity> {
  const client = privy();
  const claims = await client.utils().auth().verifyAccessToken(accessToken);
  const user = await client.users()._get(claims.user_id);
  return identityFromPrivyUser(user as unknown as { id: string; linked_accounts: LinkedAccount[] });
}

// ----------------------------------------------------------------------------
// The inbox-takeover gate's reads (INBOX_GAP_PLAN r18). Everything the gate judges comes from Privy's API with the
// app secret, never from the browser.
// ----------------------------------------------------------------------------

export interface PrivyAccountRead {
  privyUserId: string;
  /// The user's one linked email, normalized; null when there is none.
  email: string | null;
  user: GateUser;
  /// The resource of the single embedded wallet, when there is exactly one with an id; otherwise null.
  wallet: GateWallet | null;
}

async function readById(client: PrivyClient, userId: string): Promise<PrivyAccountRead> {
  const raw = (await client.users()._get(userId)) as unknown as GateUser & {
    linked_accounts: Array<GateUser['linked_accounts'][number]>;
  };
  const emails = raw.linked_accounts.filter((a) => a.type === 'email' && typeof a.address === 'string');
  const email = emails.length === 1 ? normalizeEmail(emails[0].address as string) : null;
  const embedded = embeddedWallets(raw);
  let wallet: GateWallet | null = null;
  // The resource is read only when the factors pass and there is exactly one embedded wallet with an id: a refusal
  // that needs no resource costs no second call.
  if (judgeFactors(raw).ok && embedded.length === 1 && embedded[0].id) {
    const w = (await client.wallets().get(embedded[0].id)) as unknown as {
      id: string;
      address: string;
      exported_at: number | null;
      imported_at: number | null;
      additional_signers: unknown[] | null;
    };
    wallet = {
      id: w.id,
      address: w.address,
      exported_at: w.exported_at ?? null,
      imported_at: w.imported_at ?? null,
      additional_signers: w.additional_signers ?? [],
    };
  }
  return { privyUserId: raw.id, email, user: raw, wallet };
}

/// Verifies the access token, then reads the user and its wallet resource.
export async function readPrivyAccount(accessToken: string): Promise<PrivyAccountRead> {
  const client = privy();
  const claims = await client.utils().auth().verifyAccessToken(accessToken);
  return readById(client, claims.user_id);
}

/// A fresh read by Privy user id, for the re-checks after a session exists ([J3], [K4]). Throws when Privy cannot be
/// read: the caller fails closed.
export async function readPrivyAccountById(privyUserId: string): Promise<PrivyAccountRead> {
  return readById(privy(), privyUserId);
}

export function judgeAccount(read: PrivyAccountRead, admission: GateAdmission | null, checkpoint: EnrollmentCheckpoint | null): GateVerdict {
  return judgePrivyUser(read.user, read.wallet, admission, checkpoint);
}

export type IdentityCheck =
  | { ok: true }
  | { ok: false; status: 'email_changed'; observedEmail: string | null }
  | { ok: false; status: 'account_locked' | 'mfa_enrollment_required' | 'wallet_required'; reason: string };

/// [J3] The bound account still matches Privy: the same Privy user, its one email equal to the admitted one, and the
/// gate still passing on the admitted wallet. Pure over a fresh read.
export function checkIdentity(read: PrivyAccountRead, account: { email: string; admission: GateAdmission }): IdentityCheck {
  if (read.email === null || read.email !== normalizeEmail(account.email)) {
    return { ok: false, status: 'email_changed', observedEmail: read.email };
  }
  // An admitted account: the checkpoint mattered only at its first admission.
  const v = judgeAccount(read, account.admission, null);
  if (!v.ok) return { ok: false, status: v.status, reason: v.reason };
  return { ok: true };
}
