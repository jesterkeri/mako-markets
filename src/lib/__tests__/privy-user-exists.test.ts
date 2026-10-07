// privyUserExists (src/lib/privy-server.ts): false ONLY on Privy's own 404, so Start over never reports a deletion it
// cannot confirm. The SDK's real NotFoundError class is used; only the client's network call is replaced.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ get: (() => Promise.resolve({})) as (id: string) => Promise<unknown> }));
vi.mock('@privy-io/node', async (orig) => ({
  ...(await orig<typeof import('@privy-io/node')>()),
  PrivyClient: class {
    users() {
      return { _get: (id: string) => state.get(id) };
    }
  },
}));
vi.mock('@/db/client', () => ({ db: {} }));

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_PRIVY_APP_ID', 'test-app-id');
  vi.stubEnv('PRIVY_APP_SECRET', 'test-only-not-a-secret');
});
afterAll(() => vi.unstubAllEnvs());

describe('privyUserExists', () => {
  it('true when Privy returns the user; false only on its NotFoundError; any other failure throws', async () => {
    const { NotFoundError, APIConnectionTimeoutError, InternalServerError } = await import('@privy-io/node');
    const { privyUserExists } = await import('../privy-server');
    state.get = async () => ({ id: 'did:privy:x' });
    expect(await privyUserExists('did:privy:x')).toBe(true);
    state.get = async () => {
      throw new NotFoundError(404, { error: 'User not found' }, 'User not found', new Headers());
    };
    expect(await privyUserExists('did:privy:x')).toBe(false);
    state.get = async () => {
      throw new APIConnectionTimeoutError();
    };
    await expect(privyUserExists('did:privy:x')).rejects.toThrow();
    state.get = async () => {
      throw new InternalServerError(500, {}, 'boom', new Headers());
    };
    await expect(privyUserExists('did:privy:x')).rejects.toThrow();
  });
});
