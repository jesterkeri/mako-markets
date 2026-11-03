// Adversary pass on feat/referral-competition@1ba67fe. standings.ts documents readOutcomes as "Throws when the whole
// read fails (the page shows its error line; nothing is cached)". The read uses viem's multicall with
// allowFailure: true, and viem then turns a transport error (RPC down, -32011 rate limit, timeout) into a per-call
// { status: 'failure' } instead of throwing (node_modules/viem/actions/public/multicall.ts, Promise.allSettled branch).
// So with the RPC down, every pool reads as unsettled and the page shows a real-looking board with nobody ranked,
// cached for two minutes, instead of its error line.
//
// The client here is a real viem public client on the repo's own monadTestnet chain (so multicall3 resolves), with a
// transport that fails every request, which is what an outage looks like to viem. No network is touched.

import { createPublicClient, custom } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
const rpc = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/aa-public-client', async () => {
  const { monadTestnet } = await import('@/lib/chain');
  const client = createPublicClient({
    chain: monadTestnet,
    transport: custom({
      request: async () => {
        rpc.calls += 1;
        throw new Error('rpc down');
      },
    }),
  });
  return { getAaPublicClient: () => client };
});

import { readCompetitionStandings } from '@/lib/competition/standings';
import type { TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { account, addr, at, codeOf, competitionDb, event } from './db';

let t: TestDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
  rpc.calls = 0;
});

const U = 1_000_000n;

describe('adversary: standings when the chain read fails entirely', () => {
  it('a full RPC outage is an error, not a board where nobody is ranked', async () => {
    t = await competitionDb();
    const referrer = addr('a1');
    await account(t, { wallet: referrer });
    for (const f of [addr('b1'), addr('b2')]) {
      await account(t, { wallet: f, ref: codeOf(referrer) });
      await event(t, { actor: f, market: 900, kind: 'bet', amount: U / 10n, when: at(1) });
    }
    // Five pools the entrant bet on and won: with a working chain read this player is ranked.
    for (let m = 10; m < 15; m += 1) await event(t, { actor: referrer, market: m, kind: 'bet', amount: U, when: at(2) });

    const result = readCompetitionStandings(t.db as never).then(
      (s) => ({ threw: false as const, ranked: s.ranked.length, unranked: s.unranked.map((r) => `${r.actor} settled=${r.settled}`) }),
      () => ({ threw: true as const }),
    );
    const out = await result;
    expect(rpc.calls).toBeGreaterThan(0); // the chain was asked, and every request failed
    // The documented contract: the whole read failing throws, so the page shows "Can't load the standings right now".
    expect(out).toEqual({ threw: true });
  }, 30_000); // viem retries a failing transport before the multicall settles
});
