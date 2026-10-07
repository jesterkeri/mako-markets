// The sign-in dialog's session exchange (14a): how each /api/user/auth and /api/user/auth/totp response reads, and
// the first-sign-in flag that shows the one-time beta notice.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TotpRequiredState } from '@/components/signup/TotpStep';
import { confirmWalletFree, continueGatedSignIn, GATE_MESSAGES, type GateBridge } from '../privy-gated-signin';
import { submitTotp } from '../session-exchange';

const USER = {
  authed: true,
  authType: 'magic',
  email: 'a@b.co',
  magicEoa: '0x1',
  safeAddress: '0x2',
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  nextEmailChangeAvailableAt: null,
};

function respond(status: number, body: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}
afterEach(() => vi.restoreAllMocks());

const NONCE = 'n'.repeat(43);
/// A Privy bridge for the gated sign-in: the token, an embedded wallet, and a signature over whatever it is asked.
function bridge(over: Partial<GateBridge> = {}): GateBridge & { signed: string[] } {
  const signed: string[] = [];
  return {
    signed,
    token: async () => 'tok-1',
    enrollStart: async () => ({ secret: 'S', authUrl: 'otpauth://totp/x' }),
    enrollFinish: async () => {},
    freshFactor: async () => {},
    createWallet: async () => '0xabc',
    embeddedAddress: () => '0xabc',
    signProof: async (message) => {
      signed.push(message);
      return `0x${'1'.repeat(130)}`;
    },
    ...over,
  };
}
/// fetch answers the proof route first, then the auth route.
function routes(proof: [number, unknown], auth?: [number, unknown]) {
  const answers = [proof, ...(auth ? [auth] : [])];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const [status, body] = answers.shift() ?? [500, { error: 'internal' }];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
}
const NONCE_OK: [number, unknown] = [200, { ok: true, status: 'proof_required', nonce: NONCE }];

describe('the gated sign-in (INBOX_GAP_PLAN r18)', () => {
  it('signs in and flags the first sign-in only when the route says this sign-in created the account', async () => {
    routes(NONCE_OK, [200, { ok: true, ...USER, lastSignInAt: null, firstSignIn: true }]);
    expect(await continueGatedSignIn(bridge(), 'makomarket.xyz')).toEqual({ kind: 'session', result: { kind: 'signed_in', user: { ...USER, lastSignInAt: null }, firstSignIn: true } });
    routes(NONCE_OK, [200, { ok: true, ...USER, lastSignInAt: '2026-09-01T00:00:00.000Z' }]);
    expect(await continueGatedSignIn(bridge(), 'makomarket.xyz')).toMatchObject({ kind: 'session', result: { kind: 'signed_in', firstSignIn: false } });
  });

  it('never puts the route\u2019s ok flag in the cached user', async () => {
    routes(NONCE_OK, [200, { ok: true, ...USER, lastSignInAt: null }]);
    const r = await continueGatedSignIn(bridge(), 'makomarket.xyz');
    expect(r.kind === 'session' && r.result.kind === 'signed_in' && 'ok' in r.result.user).toBe(false);
  });

  it('signs the message it built itself (this site, the nonce, the time) and posts it with the token', async () => {
    routes(NONCE_OK, [200, { ok: true, ...USER, lastSignInAt: null }]);
    const b = bridge();
    await continueGatedSignIn(b, 'makomarket.xyz');
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(['/api/user/auth/proof', '/api/user/auth']);
    expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({ privyAccessToken: 'tok-1' });
    const sent = JSON.parse(String((calls[1][1] as RequestInit).body));
    expect(sent.privyAccessToken).toBe('tok-1');
    expect(b.signed).toEqual([sent.proof.message]);
    expect(sent.proof.message).toMatch(new RegExp(`^Mako Market sign-in\\nSite: makomarket\\.xyz\\nNonce: ${NONCE}\\nIssued: `));
  });

  it('refuses to sign a nonce of any other shape [B2]', async () => {
    const b = bridge();
    routes([200, { ok: true, status: 'proof_required', nonce: `0x${'ab'.repeat(32)}` }]);
    expect((await continueGatedSignIn(b, 'makomarket.xyz')).kind).toBe('session');
    expect(b.signed).toEqual([]);
  });

  it('sends the dialog to enrollment or wallet setup when the server says so, signing nothing', async () => {
    const b = bridge();
    routes([200, { ok: false, status: 'mfa_enrollment_required' }]);
    expect(await continueGatedSignIn(b, 'm')).toEqual({ kind: 'enroll' });
    routes([200, { ok: false, status: 'wallet_required' }]);
    expect(await continueGatedSignIn(b, 'm')).toEqual({ kind: 'wallet_setup' });
    expect(b.signed).toEqual([]);
  });

  it('asks for the second factor when the account has Mako\u2019s own', async () => {
    routes(NONCE_OK, [200, { ok: true, status: 'totp_required', challengeId: 'c-1' }]);
    expect(await continueGatedSignIn(bridge(), 'm')).toEqual({ kind: 'session', result: { kind: 'totp', challengeId: 'c-1' } });
  });

  it('a cancelled authenticator prompt, a network error or a server error is a retry', async () => {
    routes(NONCE_OK);
    expect(await continueGatedSignIn(bridge({ signProof: async () => { throw new Error('MFA canceled'); } }), 'm')).toMatchObject({ result: { kind: 'retry' } });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    expect(await continueGatedSignIn(bridge(), 'm')).toMatchObject({ result: { kind: 'retry' } });
    routes([503, { error: 'internal' }]);
    expect(await continueGatedSignIn(bridge(), 'm')).toMatchObject({ result: { kind: 'retry' } });
  });

  it('names each refusal', async () => {
    routes([403, { ok: false, status: 'account_locked' }]);
    expect(await continueGatedSignIn(bridge(), 'm')).toEqual({ kind: 'session', result: { kind: 'error', message: GATE_MESSAGES.account_locked } });
    routes(NONCE_OK, [403, { ok: false, status: 'email_changed' }]);
    expect(await continueGatedSignIn(bridge(), 'm')).toEqual({ kind: 'session', result: { kind: 'error', message: GATE_MESSAGES.email_changed } });
    routes(NONCE_OK, [401, { error: 'bad_token' }]);
    expect(await continueGatedSignIn(bridge(), 'm')).toEqual({ kind: 'session', result: { kind: 'error', message: 'The sign-in code expired. Ask for a new one.' } });
  });

  it('the refusal copy has no em dash and no we/our/us', () => {
    for (const m of Object.values(GATE_MESSAGES)) {
      expect(m).not.toMatch(/\u2014/);
      expect(m).not.toMatch(/\b(we|our|us)\b/i);
    }
  });
});

describe('the first-sign-in welcome (live test L2, 2026-10-07)', () => {
  it('follows the route\'s firstSignIn, not "no earlier session" (signing out deletes the session)', async () => {
    routes(NONCE_OK, [200, { ok: true, ...USER, lastSignInAt: null, firstSignIn: false }]);
    expect(await continueGatedSignIn(bridge(), 'm')).toMatchObject({ kind: 'session', result: { kind: 'signed_in', firstSignIn: false } });
    vi.restoreAllMocks();
    routes(NONCE_OK, [200, { ok: true, ...USER, lastSignInAt: '2026-10-01T00:00:00.000Z', firstSignIn: true }]);
    expect(await continueGatedSignIn(bridge(), 'm')).toMatchObject({ kind: 'session', result: { kind: 'signed_in', firstSignIn: true } });
  });
});

describe('confirmWalletFree: the checkpoint before a wallet is created (migration 0014)', () => {
  it('only the server\'s wallet_required lets the wallet be created, and it asks explicitly for the checkpoint', async () => {
    routes([200, { ok: false, status: 'wallet_required' }]);
    expect(await confirmWalletFree(bridge())).toEqual({ ok: true });
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ privyAccessToken: 'tok-1', checkpoint: true });
  });
  it('the plain status call (continueGatedSignIn) never asks for a checkpoint', async () => {
    routes([200, { ok: false, status: 'wallet_required' }]);
    await continueGatedSignIn(bridge(), 'm');
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ privyAccessToken: 'tok-1' });
  });
  it('any other answer means do not create one: a lock, an enrollment, or a wallet that already exists', async () => {
    for (const body of [{ ok: false, status: 'account_locked' }, { ok: false, status: 'mfa_enrollment_required' }, { ok: true, status: 'proof_required', nonce: NONCE }]) {
      routes([body.status === 'account_locked' ? 403 : 200, body]);
      expect(await confirmWalletFree(bridge())).toEqual({ ok: false, retry: false });
      vi.restoreAllMocks();
    }
  });
  it('a failed checkpoint write (503), a network error or no token is a retry, never a go-ahead', async () => {
    routes([503, { error: 'unavailable' }]);
    expect(await confirmWalletFree(bridge())).toEqual({ ok: false, retry: true });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await confirmWalletFree(bridge())).toEqual({ ok: false, retry: true });
    expect(await confirmWalletFree(bridge({ token: async () => null }))).toEqual({ ok: false, retry: true });
  });
});

describe('submitTotp', () => {
  const state: TotpRequiredState = { kind: 'totp_required', challengeId: 'c-1', mode: 'totp', submitting: true, error: null, lockedUntil: null, terminal: null };

  it('sends the code or the recovery code for the challenge', async () => {
    respond(200, { ok: true, ...USER, lastSignInAt: null });
    await submitTotp(state, '123456');
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body))).toEqual({ challengeId: 'c-1', code: '123456' });
    vi.restoreAllMocks();
    respond(200, { ok: true, ...USER, lastSignInAt: null });
    await submitTotp({ ...state, mode: 'recovery' }, 'abcd-efgh');
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body))).toEqual({ challengeId: 'c-1', recoveryCode: 'abcd-efgh' });
  });

  it('signs in on success; the /totp path is never the account-creating sign-in, even with no earlier session', async () => {
    respond(200, { ok: true, ...USER, lastSignInAt: null, firstSignIn: false });
    expect(await submitTotp(state, '123456')).toMatchObject({ kind: 'signed_in', firstSignIn: false });
    vi.restoreAllMocks();
    respond(200, { ok: true, ...USER, lastSignInAt: null });
    expect(await submitTotp(state, '123456')).toMatchObject({ kind: 'signed_in', firstSignIn: false });
  });

  it('reads failures through the reviewed mapper: wrong code, lockout, expired challenge', async () => {
    respond(401, { error: 'totp_failed' });
    expect(await submitTotp(state, '000000')).toMatchObject({ kind: 'state', next: { submitting: false, error: 'That code is wrong. Try a fresh one from your authenticator.' } });
    respond(429, { error: 'totp_locked', retryAt: '2026-09-30T23:00:00.000Z' });
    expect(await submitTotp(state, '000000')).toMatchObject({ kind: 'state', next: { lockedUntil: Date.parse('2026-09-30T23:00:00.000Z') } });
    respond(401, { error: 'challenge_invalid' });
    expect(await submitTotp(state, '000000')).toMatchObject({ kind: 'state', next: { terminal: 'challenge_invalid' } });
  });
});
