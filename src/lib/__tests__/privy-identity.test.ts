// Privy sign-in (Joshua, 2026-09-29: everyone moves to Privy). Two pure pieces:
//   - identityFromPrivyUser: which email and which wallets of a Privy user count;
//   - decideEmbeddedUser: create, reuse, move once, or refuse, for the rows that already match.

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@privy-io/node', () => ({ PrivyClient: class {} }));
vi.mock('@/db/client', () => ({ db: {} }));

import type { User } from '@/db/schema';
import { identityFromPrivyUser, PrivyIdentityError } from '../privy-server';
import { decideEmbeddedUser } from '../user-upsert';

const W0 = '0x' + 'a'.repeat(40);
const W1 = '0x' + 'b'.repeat(40);
const MAGIC = '0x' + 'c'.repeat(40);

const wallet = (address: string, over: Record<string, unknown> = {}) => ({
  type: 'wallet',
  address,
  chain_type: 'ethereum',
  connector_type: 'embedded',
  wallet_client_type: 'privy',
  imported: false,
  wallet_index: 0,
  ...over,
});

describe('identityFromPrivyUser', () => {
  it('takes the verified email and the Privy embedded Ethereum wallets, lowest index first, lowercase', () => {
    const id = identityFromPrivyUser({
      id: 'did:privy:u1',
      linked_accounts: [
        wallet(W1.toUpperCase().replace('0X', '0x'), { wallet_index: 1 }),
        { type: 'email', address: 'a@b.com' },
        wallet(W0, { wallet_index: 0 }),
      ],
    });
    expect(id).toEqual({ privyUserId: 'did:privy:u1', email: 'a@b.com', wallets: [W0, W1] });
  });

  it('never counts an external, imported, Solana or malformed wallet', () => {
    const accounts = [
      { type: 'email', address: 'a@b.com' },
      wallet(W0, { connector_type: 'injected', wallet_client_type: 'metamask' }),
      wallet(W0, { imported: true }),
      wallet(W0, { chain_type: 'solana' }),
      wallet('0x1234'),
    ];
    expect(() => identityFromPrivyUser({ id: 'u', linked_accounts: accounts })).toThrow(PrivyIdentityError);
  });

  it('refuses a Privy user with no email', () => {
    expect(() => identityFromPrivyUser({ id: 'u', linked_accounts: [wallet(W0)] })).toThrow(/no_email/);
  });
});

const row = (over: Partial<User>): User => ({ id: 'user-1', email: 'a@b.com', magicEoa: MAGIC, ...over }) as User;

describe('decideEmbeddedUser', () => {
  it('creates a new account signed by the first Privy wallet', () => {
    expect(decideEmbeddedUser([], 'a@b.com', [W0, W1])).toEqual({ action: 'create', eoa: W0 });
  });

  it('reuses an account already signed by one of the Privy wallets, even not the first', () => {
    const r = row({ magicEoa: W1 });
    expect(decideEmbeddedUser([r], 'a@b.com', [W0, W1])).toEqual({ action: 'reuse', row: r });
  });

  it('moves a Magic-era account, once, to the first Privy wallet', () => {
    const r = row({ magicEoa: MAGIC });
    expect(decideEmbeddedUser([r], 'a@b.com', [W0])).toEqual({ action: 'move', row: r, eoa: W0 });
    // After the move the account's signer is W0: the same sign-in now reuses, it never moves again.
    expect(decideEmbeddedUser([row({ magicEoa: W0 })], 'a@b.com', [W0, W1]).action).toBe('reuse');
  });

  it('refuses a wallet that already signs for a different email', () => {
    expect(decideEmbeddedUser([row({ email: 'other@b.com', magicEoa: W0 })], 'a@b.com', [W0])).toEqual({
      action: 'conflict',
      reason: 'eoa_with_different_email',
    });
  });

  it('refuses when the email and a wallet point at two different accounts', () => {
    const a = row({ id: 'u1', email: 'a@b.com', magicEoa: MAGIC });
    const b = row({ id: 'u2', email: 'x@y.com', magicEoa: W0 });
    expect(decideEmbeddedUser([a, b], 'a@b.com', [W0]).action).toBe('conflict');
  });
});
