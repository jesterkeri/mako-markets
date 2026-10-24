// The browser half of Codex CLAIM_TILE R2 F1: every sponsored request names the account it acts for, and the route's
// refusal reads as a sign-in on another tab, with nothing sent.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildClaimBody, runSponsoredRequest } from '@/lib/aa-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { phaseFromOutcome, type OutcomeWords } from '@/lib/confirm-outcome';
import { MAKO_ADDRESS } from '@/lib/contract';

const EOA = '0x2222222222222222222222222222222222222222';

afterEach(() => vi.restoreAllMocks());

describe('sponsor requests name their account', () => {
  it('runSponsoredRequest sends x-mako-eoa, and a session_changed refusal reads as a sign-in elsewhere', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'session_changed' }), { status: 409 }));
    const outcome = await runSponsoredRequest(buildClaimBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 7n }), EOA);
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-mako-eoa']).toBe(EOA);
    expect(outcome).toMatchObject({ kind: 'sponsor_failed', status: 409, error: 'session_changed' });
    const phase = phaseFromOutcome(outcome, { noun: 'claim', failTitle: 'Claim not sent' } satisfies OutcomeWords);
    expect(phase).toMatchObject({ step: 'failed', title: 'Signed in elsewhere', nothingMoved: true });
  });
});
