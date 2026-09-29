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
