// Adversary pass on 2d788bb (5 pools to be ranked, open or settled). Spec rule 6 (owner 2026-10-27): "A failed chain
// read is still an error, never a quietly smaller pool count or a board where nobody is ranked."
//
// viem's multicall builds its result list from the DECODED aggregate3 answer, not from the request
// (node_modules/viem/_esm/actions/public/multicall.js:151-171 loops `aggregate3Result.length`). A node that answers a
// chunk with fewer entries than it was asked for therefore yields a shorter list in which every entry is 'success'.
// readOutcomes only checks `status`, so the missing pool has no outcome, and foldPositions (`if (o && ...)`) drops it
// from `pools` without a word: a player with 5 counted pools is shown as 4 and falls out of the ranked list.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
const chain = vi.hoisted(() => ({ answered: 0 }));
vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({
    // Every pool is open (resolved false); the node answers only the first `answered` calls, all as successes.
    multicall: async ({ contracts }: { contracts: { args: readonly [bigint] }[] }) =>
      contracts.slice(0, chain.answered).map(() => ({ status: 'success', result: { resolved: false, outcome: 0 } })),
  }),
}));

import { readCompetitionStandings } from '@/lib/competition/standings';
import type { TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { account, addr, at, codeOf, competitionDb, event } from './db';

let t: TestDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const U = 1_000_000n;
const REF = addr('a1');

describe('adversary 2d788bb: a short multicall answer', () => {
  it('is an error, not a player quietly dropped from 5 pools to 4 and out of the ranked list', async () => {
    t = await competitionDb();
    await account(t, { wallet: REF });
    for (const tag of ['f0', 'f1']) {
      await account(t, { wallet: addr(tag), ref: codeOf(REF) });
      await event(t, { actor: addr(tag), market: 900, kind: 'bet', amount: U / 10n, when: at(2) });
    }
    for (let m = 10; m < 15; m += 1) await event(t, { actor: REF, market: m, kind: 'bet', amount: U, when: at(1) });

    // Control: a full answer ranks the player on 5 open pools.
    chain.answered = 5;
    const full = await readCompetitionStandings(t.db as never);
    expect(full.ranked.map((r) => [r.actor, r.pools])).toEqual([[REF, 5]]);

    // The node answers 4 of the 5 calls. Rule 6: this must throw (the page shows its error line), not render a board.
    chain.answered = 4;
    await expect(readCompetitionStandings(t.db as never)).rejects.toThrow();
  });
});
