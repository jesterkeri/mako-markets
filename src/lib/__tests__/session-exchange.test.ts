// The sign-in dialog's session exchange (14a): how each /api/user/auth and /api/user/auth/totp response reads, and
// the first-sign-in flag that shows the one-time beta notice.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TotpRequiredState } from '@/components/signup/TotpStep';
import { exchangePrivyToken, submitTotp } from '../session-exchange';

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

describe('exchangePrivyToken', () => {
  it('signs in and flags the first sign-in only when the route says there was none before', async () => {
    respond(200, { ok: true, ...USER, lastSignInAt: null });
    expect(await exchangePrivyToken('t')).toEqual({ kind: 'signed_in', user: { ...USER, lastSignInAt: null }, firstSignIn: true });
    respond(200, { ok: true, ...USER, lastSignInAt: '2026-09-01T00:00:00.000Z' });
    expect(await exchangePrivyToken('t')).toMatchObject({ kind: 'signed_in', firstSignIn: false });
  });

  it('never puts the route’s ok flag in the cached user', async () => {
    respond(200, { ok: true, ...USER, lastSignInAt: null });
    const r = await exchangePrivyToken('t');
    expect(r.kind === 'signed_in' && 'ok' in r.user).toBe(false);
  });

  it('posts only the Privy token, to the auth route', async () => {
    respond(200, { ok: true, ...USER, lastSignInAt: null });
    await exchangePrivyToken('tok-1');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/user/auth');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ privyAccessToken: 'tok-1' });
  });

  it('asks for the second factor when the account has one', async () => {
    respond(200, { ok: true, status: 'totp_required', challengeId: 'c-1' });
    expect(await exchangePrivyToken('t')).toEqual({ kind: 'totp', challengeId: 'c-1' });
  });

  it('keeps the proof usable after a network or server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    expect((await exchangePrivyToken('t')).kind).toBe('retry');
    respond(503, { error: 'internal' });
    expect((await exchangePrivyToken('t')).kind).toBe('retry');
    respond(200, 'not json');
    expect((await exchangePrivyToken('t')).kind).toBe('retry');
  });

  it('names each refusal', async () => {
    respond(409, { error: 'identity_conflict' });
    expect(await exchangePrivyToken('t')).toEqual({ kind: 'error', message: 'This email belongs to an account with a different wallet, so sign-in stopped to keep it safe.' });
    respond(401, { error: 'bad_token' });
    expect(await exchangePrivyToken('t')).toEqual({ kind: 'error', message: 'The sign-in code expired. Ask for a new one.' });
    respond(400, { error: 'something_new' });
    expect(await exchangePrivyToken('t')).toEqual({ kind: 'error', message: 'Sign-in failed. Please try again.' });
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

  it('signs in on success, carrying the first-sign-in flag', async () => {
    respond(200, { ok: true, ...USER, lastSignInAt: null });
    expect(await submitTotp(state, '123456')).toMatchObject({ kind: 'signed_in', firstSignIn: true });
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
