// Self-service Start over (src/lib/start-over.ts): only a locked account that never completed its first sign-in, with
// no email-moved conflict and no browser that could still finish, is eligible.
import { describe, expect, it } from 'vitest';

import { startOverDecision, type StartOverFacts } from '@/lib/start-over';

const base: StartOverFacts = { verdictStatus: 'account_locked', boundToAccount: false, emailMoved: false, liveCheckpoint: false };

describe('startOverDecision', () => {
  it('eligible only when locked, never admitted, no email move, and no browser can still finish', () => {
    expect(startOverDecision(base)).toEqual({ eligible: true });
  });
  it('an account that ever signed in is never eligible, whatever else holds', () => {
    expect(startOverDecision({ ...base, boundToAccount: true })).toEqual({ eligible: false, reason: 'admitted' });
  });
  it('an email-moved conflict keeps its own handling', () => {
    expect(startOverDecision({ ...base, emailMoved: true })).toEqual({ eligible: false, reason: 'email_changed' });
    expect(startOverDecision({ ...base, emailMoved: true, boundToAccount: true })).toEqual({ eligible: false, reason: 'email_changed' });
  });
  it('anything but a lock is not eligible: enrol, create the wallet, or sign in instead', () => {
    for (const s of ['ok', 'mfa_enrollment_required', 'wallet_required'] as const) {
      expect(startOverDecision({ ...base, verdictStatus: s })).toEqual({ eligible: false, reason: 'not_locked' });
    }
  });
  it('a browser still holding an unexpired checkpoint can finish there, so nothing is deleted', () => {
    expect(startOverDecision({ ...base, liveCheckpoint: true })).toEqual({ eligible: false, reason: 'finish_elsewhere' });
  });
});
