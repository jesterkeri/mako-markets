// Adversary pass on feat/me-rounds-indexer (6469ed3): an indexer answer that is impossible for the chain Me reads.
//
// me-rounds-discovery.ts promises that every id the indexer cannot vouch for is read on chain, and that an indexer
// that is wrong or stuck makes the rounds part unavailable rather than partial. The read plan only checks one
// direction: an indexer far BEHIND the chain is refused, but an indexer far AHEAD of it (it claims hundreds of rounds
// the contract has never scheduled) is accepted, and the plan then reads only the newest ME_ROUNDS_RECENT ids plus
// the discovered ids. That happens whenever ENVIO_ROUNDS_GRAPHQL_URL serves a different MakoRoundsV1 deployment than
// NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS (a redeploy, a Preview pointed at the production indexer), or GlobalStats.rounds is
// overcounted. An account's claimable stake in an older round of the contract Me actually reads is then not read, and
// the hook reports `ready`, not `error`.

import { describe, expect, it } from 'vitest';

import { planMeRoundReads } from '@/lib/me-rounds-discovery';

describe('adversary: an indexer that claims far more rounds than the chain has', () => {
  it('is refused (unavailable), never planned as a complete read', () => {
    // The chain Me reads has 30 rounds. The account holds a claimable win in round 5 of it.
    const count = 30n;
    // The indexer answers for another deployment: 500 rounds seen, the account's entries are in its rounds 200 and 450.
    const discovery = {
      roundIds: [200n, 450n],
      indexedThrough: 500n,
      head: { id: 500n, openTime: 1_760_000_000n, startTime: 1_760_000_900n, creator: '0x00000000000000000000000000000000000000c2' },
    };

    const plan = planMeRoundReads(count, discovery);

    // Round 5 can only be found by reading it; a plan that leaves it out must not be offered as complete.
    if (plan.ok) expect(plan.ids).toContain(5n);
    expect(plan).toEqual({ ok: false, reason: expect.any(String) });
  });
});
