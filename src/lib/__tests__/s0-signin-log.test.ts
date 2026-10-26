// S0 logger: remove after the beta measurement (with src/lib/s0-signin-log.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reads: 0 }));
vi.mock('@/lib/privy-server', () => ({
  readPrivyAccount: async () => {
    h.reads += 1;
    return READ;
  },
}));

import { s0Log } from '@/lib/s0-signin-log';

const SID = 'cl-session-raw-id-123';
const PRIVY = 'did:privy:rawuserid';
const EMAIL = 'owner@example.com';
const READ = {
  privyUserId: PRIVY,
  email: EMAIL,
  user: {
    id: PRIVY,
    mfa_methods: [{ type: 'totp', verified_at: 1_790_000_100 }],
    linked_accounts: [{ type: 'email', address: EMAIL, latest_verified_at: 1_790_000_500 }],
  },
  wallet: null,
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'ES256' })}.${b64({ sid: SID, sub: PRIVY, iss: 'privy.io', aud: 'app', iat: 1_790_000_503, exp: 1_790_004_103 })}.c2lnbmF0dXJl`;

let lines: string[];
beforeEach(() => {
  lines = [];
  h.reads = 0;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('S0 sign-in logger', () => {
  it('is off unless S0_SIGNIN_LOG=1', async () => {
    await s0Log('step_a', TOKEN, READ as never);
    expect(lines).toEqual([]);
    expect(h.reads).toBe(0);
  });

  it('refuses to run in production even when set', async () => {
    vi.stubEnv('S0_SIGNIN_LOG', '1');
    vi.stubEnv('VERCEL_ENV', 'production');
    await s0Log('final', TOKEN, READ as never);
    expect(lines.join('\n')).not.toMatch(/"step"/);
    expect(h.reads).toBe(0);
  });

  it('prints one [S0] line of claim names, timestamps and hashes, and nothing identifying', async () => {
    vi.stubEnv('S0_SIGNIN_LOG', '1');
    vi.stubEnv('VERCEL_ENV', 'preview');
    await s0Log('step_a', TOKEN);
    expect(h.reads).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('[S0] ')).toBe(true);
    const line = JSON.parse(lines[0].slice(5));
    expect(line).toMatchObject({
      step: 'step_a',
      claimNames: ['aud', 'exp', 'iat', 'iss', 'sid', 'sub'],
      iat: 1_790_000_503,
      exp: 1_790_004_103,
      latestVerifiedAt: 1_790_000_500,
      iatMinusVerified: 3,
      totpVerifiedAt: [1_790_000_100],
    });
    expect(line.sid).toMatch(/^[0-9a-f]{16}$/);
    expect(line.user).toMatch(/^[0-9a-f]{16}$/);
    for (const secret of [SID, PRIVY, EMAIL, TOKEN, TOKEN.split('.')[1], 'c2lnbmF0dXJl', 'rawuserid']) {
      expect(lines[0]).not.toContain(secret);
    }
  });

  it('never throws: a failed read logs only the error name', async () => {
    vi.stubEnv('S0_SIGNIN_LOG', '1');
    await expect(s0Log('proof', 'not-a-jwt', { ...READ, user: null } as never)).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice(5))).toMatchObject({ step: 'proof', error: 'TypeError' });
  });
});
