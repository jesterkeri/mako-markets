// The pure rules of remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2, section 4 "Step A", "Step B" and
// "shortcut-check"): every decision over values the routes read under their locks and their live time `t`.
import { describe, expect, it } from 'vitest';

import {
  cookieSecret,
  decideShortcutCheck,
  decideStepA,
  decideStepB,
  emailLatestVerifiedAt,
  factorFingerprint,
  hashSecret,
  hashSid,
  reissuable,
  usableCeremony,
  type Ceremony,
  type RememberedRow,
} from '@/lib/remembered-browser-rules';

const T = Date.UTC(2026, 9, 26, 12, 0, 0);
const MIN = 60_000;
const V = T / 1000 - 60; // latest_verified_at (s): the code was entered a minute before T
const SID = hashSid('sid-1');
const EC = hashSecret('e'.repeat(43));
const RB = hashSecret('r'.repeat(43));
const PRIVY = 'did:privy:u1';
const FP = 1_791_000_000;

const ceremony = (o: Partial<Ceremony> = {}): Ceremony => ({
  id: 'c1',
  secretHash: EC,
  createdAt: new Date(T - 5 * MIN),
  verifiedAt: null,
  verifiedSidHash: null,
  verifiedPrivyUserId: null,
  verifiedValue: null,
  usedAt: null,
  voidedAt: null,
  attempts: 0,
  ...o,
});
const verified = (o: Partial<Ceremony> = {}) =>
  ceremony({ verifiedAt: new Date(T - 2 * MIN), verifiedSidHash: SID, verifiedPrivyUserId: PRIVY, verifiedValue: V, ...o });
const row = (o: Partial<RememberedRow> = {}): RememberedRow => ({
  id: 'r1',
  userId: 'u1',
  privySidHash: SID,
  deviceSecretHash: RB,
  ceremonyId: 'c1',
  factorFingerprint: FP,
  createdAt: new Date(T - 10 * MIN),
  lastUsedAt: null,
  expiresAt: new Date(T + 29 * 24 * 60 * MIN),
  revokedAt: null,
  ...o,
});
const stepA = (c: Ceremony | null, o: Partial<{ iat: number; value: number | null; seen: number | null; nowMs: number; sidHash: string; privyUserId: string }> = {}) =>
  decideStepA(c, { secretHash: EC, sidHash: SID, privyUserId: PRIVY, iat: V + 3, value: V, seen: null, nowMs: T, ...o });

describe('step A', () => {
  it('verifies a fresh code: an unverified ceremony under 30 minutes, 0 <= iat - v <= 120, newer than the mark', () => {
    expect(stepA(ceremony())).toEqual({ kind: 'verify' });
    expect(stepA(ceremony(), { iat: V })).toEqual({ kind: 'verify' });
    expect(stepA(ceremony(), { iat: V + 120 })).toEqual({ kind: 'verify' });
    expect(stepA(ceremony(), { seen: V - 1 })).toEqual({ kind: 'verify' });
  });
  it('refuses a refreshed retained session: a fresh iat, an old verification', () => {
    expect(stepA(ceremony(), { iat: V + 121 })).toMatchObject({ kind: 'refuse', reason: 'not_confirmed', countAttempt: true });
    expect(stepA(ceremony(), { iat: V - 1 })).toMatchObject({ kind: 'refuse', reason: 'not_confirmed' });
  });
  it('refuses a null or missing verification value (r12)', () => {
    expect(stepA(ceremony(), { value: null })).toMatchObject({ kind: 'refuse', reason: 'not_confirmed' });
  });
  it('arriving 29:59 after email-start verifies, 30:01 is "took too long" (database clock)', () => {
    const c = ceremony({ createdAt: new Date(T - 30 * MIN + 1_000) });
    expect(stepA(c, { iat: Math.floor(T / 1000) - 60, value: Math.floor(T / 1000) - 62 })).toEqual({ kind: 'verify' });
    const late = ceremony({ createdAt: new Date(T - 30 * MIN - 1_000) });
    expect(stepA(late)).toMatchObject({ kind: 'refuse', reason: 'too_late' });
  });
  it('a 2-minute outage then a retry verifies; one of 11 minutes is refused (token older than 600 s)', () => {
    const iat = Math.floor(T / 1000) - 2 * 60;
    expect(stepA(ceremony(), { iat, value: iat - 3 })).toEqual({ kind: 'verify' });
    const old = Math.floor(T / 1000) - 11 * 60;
    expect(stepA(ceremony(), { iat: old, value: old - 3 })).toMatchObject({ kind: 'refuse', reason: 'too_late' });
  });
  it('a verification Mako already recorded is "signed in on another device"', () => {
    expect(stepA(ceremony(), { seen: V })).toMatchObject({ kind: 'refuse', reason: 'other_device' });
    expect(stepA(ceremony(), { seen: V + 5 })).toMatchObject({ kind: 'refuse', reason: 'other_device' });
  });
  it('at most 10 calls on one ceremony (case 6)', () => {
    expect(stepA(ceremony({ attempts: 9 }))).toEqual({ kind: 'verify' });
    expect(stepA(ceremony({ attempts: 10 }))).toMatchObject({ kind: 'refuse', countAttempt: false });
  });
  it('is idempotent (r16): a retry on its own verified ceremony answers success; another sid or user, spent, voided or expired, is refused', () => {
    expect(stepA(verified())).toEqual({ kind: 'already' });
    expect(stepA(verified(), { sidHash: hashSid('sid-2') })).toMatchObject({ kind: 'refuse', countAttempt: false });
    expect(stepA(verified(), { privyUserId: 'did:privy:other' })).toMatchObject({ kind: 'refuse' });
    expect(stepA(verified({ usedAt: new Date(T - MIN) }))).toMatchObject({ kind: 'refuse' });
    expect(stepA(verified({ voidedAt: new Date(T - MIN) }))).toMatchObject({ kind: 'refuse' });
    expect(stepA(verified({ verifiedAt: new Date(T - 61 * MIN) }))).toMatchObject({ kind: 'refuse', reason: 'too_late' });
  });
  it('no ceremony at all is refused without counting', () => {
    expect(stepA(null)).toMatchObject({ kind: 'refuse', countAttempt: false });
  });
});

describe('a usable ceremony (r18)', () => {
  const args = { secretHash: EC, sidHash: SID, privyUserId: PRIVY, nowMs: T };
  it('is this browser secret, verified, unspent, unvoided, within 60 minutes, for this sid and user', () => {
    expect(usableCeremony(verified(), args)).toBe(true);
    expect(usableCeremony(verified({ verifiedAt: new Date(T - 60 * MIN) }), args)).toBe(true);
  });
  it.each([
    ['another browser', { secretHash: hashSecret('x'.repeat(43)) }, {}],
    ['no cookie', { secretHash: null }, {}],
    ['unverified', {}, { verifiedAt: null }],
    ['spent', {}, { usedAt: new Date(T) }],
    ['voided', {}, { voidedAt: new Date(T) }],
    ['past 60 minutes', {}, { verifiedAt: new Date(T - 60 * MIN - 1) }],
    ['another sid', { sidHash: hashSid('other') }, {}],
    ['another user', { privyUserId: 'did:privy:x' }, {}],
  ] as const)('is not, for %s', (_n, a, c) => {
    expect(usableCeremony(verified(c as Partial<Ceremony>), { ...args, ...(a as object) })).toBe(false);
  });
});

describe('step B at /api/user/auth', () => {
  const base = { enabled: true, sidHash: SID, privyUserId: PRIVY, row: null as RememberedRow | null, ceremony: null as Ceremony | null, ecHash: EC, rbHash: null as string | null, fingerprint: FP, nowMs: T };
  it('off: today', () => {
    expect(decideStepB({ ...base, enabled: false })).toEqual({ kind: 'off' });
  });
  it('case 1: no row, no usable ceremony: email_required, nothing minted (r11)', () => {
    expect(decideStepB(base)).toMatchObject({ kind: 'email_required' });
    expect(decideStepB({ ...base, ceremony: verified({ verifiedSidHash: hashSid('copied') }) })).toMatchObject({ kind: 'email_required' });
    expect(decideStepB({ ...base, ceremony: verified({ verifiedAt: new Date(T - 61 * MIN) }) })).toMatchObject({ kind: 'email_required', reason: 'too_late' });
  });
  it('case 1: no row, a usable ceremony: bind', () => {
    expect(decideStepB({ ...base, ceremony: verified() })).toMatchObject({ kind: 'bind' });
  });
  it('case 2: an active row and its mako_rb: shortcut', () => {
    expect(decideStepB({ ...base, row: row(), rbHash: RB })).toMatchObject({ kind: 'shortcut' });
  });
  it('case 3: a revoked or expired row needs the email for good, even with its cookie', () => {
    expect(decideStepB({ ...base, row: row({ revokedAt: new Date(T - 1) }), rbHash: RB })).toMatchObject({ kind: 'email_required' });
    expect(decideStepB({ ...base, row: row({ expiresAt: new Date(T) }), rbHash: RB })).toMatchObject({ kind: 'email_required' });
  });
  it('case 3: a wrong or missing mako_rb on an active row revokes it (device_mismatch)', () => {
    expect(decideStepB({ ...base, row: row(), rbHash: null })).toMatchObject({ kind: 'device_mismatch' });
    expect(decideStepB({ ...base, row: row(), rbHash: hashSecret('z'.repeat(43)) })).toMatchObject({ kind: 'device_mismatch' });
  });
  it('2.3: a changed authenticator revokes every row before anything is minted', () => {
    expect(decideStepB({ ...base, row: row(), rbHash: RB, fingerprint: FP + 1 })).toEqual({ kind: 'factor_changed' });
    expect(decideStepB({ ...base, row: row(), rbHash: RB, fingerprint: null })).toEqual({ kind: 'factor_changed' });
  });
  it('the lost reply (case 3 exception): never used, inside its ceremony 60 minutes, with that spent mako_ec: re-issue', () => {
    const spent = verified({ usedAt: new Date(T - MIN) });
    expect(decideStepB({ ...base, row: row(), ceremony: spent })).toMatchObject({ kind: 'reissue' });
    // Used once already, another ceremony, an unspent one, or past the 60 minutes: revoked instead.
    expect(decideStepB({ ...base, row: row({ lastUsedAt: new Date(T - MIN) }), ceremony: spent })).toMatchObject({ kind: 'device_mismatch' });
    expect(decideStepB({ ...base, row: row({ ceremonyId: 'c2' }), ceremony: spent })).toMatchObject({ kind: 'device_mismatch' });
    expect(decideStepB({ ...base, row: row(), ceremony: verified() })).toMatchObject({ kind: 'device_mismatch' });
    expect(decideStepB({ ...base, row: row(), ceremony: spent, nowMs: T + 59 * MIN })).toMatchObject({ kind: 'device_mismatch' });
    expect(decideStepB({ ...base, row: row(), ceremony: verified({ usedAt: new Date(T), voidedAt: new Date(T) }) })).toMatchObject({ kind: 'device_mismatch' });
  });
  it('without a sid nothing binds', () => {
    expect(decideStepB({ ...base, sidHash: null, ceremony: verified() })).toMatchObject({ kind: 'email_required' });
  });
});

describe('reissuable', () => {
  it('needs the row active', () => {
    expect(reissuable(row({ revokedAt: new Date(T) }), verified({ usedAt: new Date(T) }), EC, T)).toBe(false);
  });
});

describe('shortcut-check (read-only, before any authenticator prompt)', () => {
  const base = { sidHash: SID, privyUserId: PRIVY, row: null as RememberedRow | null, ceremony: null as Ceremony | null, ecHash: EC, rbHash: null as string | null, fingerprint: FP, nowMs: T };
  it('shortcut only for an active row expiring more than 10 minutes out, its mako_rb and the same authenticator', () => {
    expect(decideShortcutCheck({ ...base, row: row(), rbHash: RB })).toBe('shortcut');
    expect(decideShortcutCheck({ ...base, row: row({ expiresAt: new Date(T + 10 * MIN) }), rbHash: RB })).toBe('email_needed');
    expect(decideShortcutCheck({ ...base, row: row(), rbHash: RB, fingerprint: FP + 1 })).toBe('email_needed');
  });
  it('bind_possible only with more than 10 of the ceremony 60 minutes left', () => {
    expect(decideShortcutCheck({ ...base, ceremony: verified({ verifiedAt: new Date(T - 49 * MIN) }) })).toBe('bind_possible');
    expect(decideShortcutCheck({ ...base, ceremony: verified({ verifiedAt: new Date(T - 50 * MIN) }) })).toBe('email_needed');
  });
  it('rebind for the lost reply, so the recovery is reachable', () => {
    expect(decideShortcutCheck({ ...base, row: row(), ceremony: verified({ usedAt: new Date(T - MIN) }) })).toBe('rebind');
  });
  it('one answer for "no row" and "bad cookie": it reveals nothing', () => {
    expect(decideShortcutCheck(base)).toBe('email_needed');
    expect(decideShortcutCheck({ ...base, row: row(), rbHash: hashSecret('z'.repeat(43)) })).toBe('email_needed');
  });
});

describe('Privy values', () => {
  it("latest_verified_at is the email account's, the one whose address is the login email", () => {
    const user = {
      linked_accounts: [
        { type: 'wallet', address: '0xabc', latest_verified_at: V + 100 },
        { type: 'email', address: 'Owner@Example.com ', latest_verified_at: V },
      ],
    };
    expect(emailLatestVerifiedAt({ email: 'owner@example.com', user })).toBe(V);
    expect(emailLatestVerifiedAt({ email: 'other@example.com', user })).toBeNull();
    expect(emailLatestVerifiedAt({ email: null, user })).toBeNull();
    expect(emailLatestVerifiedAt({ email: 'owner@example.com', user: { linked_accounts: [{ type: 'email', address: 'owner@example.com', latest_verified_at: null }] } })).toBeNull();
  });
  it('the fingerprint is the single TOTP method verified_at, else null', () => {
    expect(factorFingerprint({ mfa_methods: [{ type: 'totp', verified_at: FP }] })).toBe(FP);
    expect(factorFingerprint({ mfa_methods: [] })).toBeNull();
    expect(factorFingerprint({ mfa_methods: [{ type: 'totp', verified_at: FP }, { type: 'totp', verified_at: FP + 1 }] })).toBeNull();
    expect(factorFingerprint({ mfa_methods: [{ type: 'sms', verified_at: FP }] })).toBeNull();
  });
  it('cookie secrets are 43 base64url characters, or nothing', () => {
    const req = (c: string) => new Request('https://x.y', { headers: { cookie: c } });
    expect(cookieSecret(req(`a=1; mako_rb=${'r'.repeat(43)}`), 'mako_rb')).toBe('r'.repeat(43));
    expect(cookieSecret(req(`mako_rb=${'r'.repeat(42)}`), 'mako_rb')).toBeNull();
    expect(cookieSecret(req('mako_ec=x'), 'mako_rb')).toBeNull();
    expect(hashSid('a')).not.toBe(hashSecret('a'));
  });
});
