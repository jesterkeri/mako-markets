// Competition standings: who is entered (referral counting), which bets and claims count (the window and the
// first-bet rule), and the pure fold and ranking. pglite for the SQL; the chain read is mocked in the one test that
// runs the whole read.

import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
const chain = vi.hoisted(() => ({ outcomes: new Map<string, { resolved: boolean; outcome: number } | 'fail'>() }));
vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({
    multicall: async ({ contracts }: { contracts: { args: readonly [bigint] }[] }) =>
      contracts.map((c) => {
        const o = chain.outcomes.get(c.args[0].toString());
        return !o || o === 'fail' ? { status: 'failure', error: new Error('reverted') } : { status: 'success', result: o };
      }),
  }),
}));

import { Outcome } from '@/lib/contract';
import { foldPositions, rankEntrants, readCompetitionStandings, readPositions, type EntrantScore, type PositionRow } from '@/lib/competition/standings';
import type { TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { account, addr, at, codeOf, competitionDb, event } from './db';

let t: TestDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
  chain.outcomes.clear();
});

const U = 1_000_000n; // 1 USDC
const REF = addr('a1');
const entrants = (rows: PositionRow[]) => [...new Set(rows.map((r) => r.actor))];

/// A referrer with `n` friends who each joined through the link and bet once before the end.
async function referrerWith(db: TestDb, referrer: string, n: number, tag = 'f') {
  await account(db, { wallet: referrer });
  for (let i = 0; i < n; i += 1) {
    const friend = addr(`${tag}${i}`);
    await account(db, { wallet: friend, ref: codeOf(referrer) });
    await event(db, { actor: friend, market: 900, kind: 'bet', amount: U / 10n, when: at(2) });
  }
}

describe('who is entered', () => {
  it('counts a wallet friend and an email friend (checksummed Safe) alike; two make an entrant', async () => {
    t = await competitionDb();
    await account(t, { wallet: REF });
    const wallet = addr('b1');
    const safe = addr('b2');
    await account(t, { wallet, ref: codeOf(REF) });
    await account(t, { safe: getAddress(safe), ref: codeOf(REF) });
    await event(t, { actor: wallet, market: 1, kind: 'bet', amount: U, when: at(1) });
    await event(t, { actor: safe, market: 1, kind: 'bet', amount: U / 10n, when: at(-100) }); // any bet before END counts
    expect(entrants(await readPositions(t.db as never))).toEqual([REF]);
  });

  it('a friend with no bet, or whose only bet is at or after the end, does not count', async () => {
    t = await competitionDb();
    await account(t, { wallet: REF });
    await account(t, { wallet: addr('b1'), ref: codeOf(REF) });
    await event(t, { actor: addr('b1'), market: 1, kind: 'bet', amount: U, when: at(1) });
    await account(t, { wallet: addr('b2'), ref: codeOf(REF) }); // no bet
    await account(t, { wallet: addr('b3'), ref: codeOf(REF) });
    await event(t, { actor: addr('b3'), market: 1, kind: 'bet', amount: U, when: at(14 * 24) }); // exactly END
    expect(await readPositions(t.db as never)).toEqual([]);
  });

  it('one qualifying friend is not enough', async () => {
    t = await competitionDb();
    await referrerWith(t, REF, 1);
    expect(await readPositions(t.db as never)).toEqual([]);
  });

  it('a self-referral does not count', async () => {
    t = await competitionDb();
    await referrerWith(t, REF, 1);
    // The referrer's own link opened in a fresh browser, with an email account whose Safe shares the code.
    const twin = `${REF.slice(0, 32)}ffffffffff`;
    await account(t, { safe: getAddress(twin), ref: codeOf(REF) });
    await event(t, { actor: twin, market: 1, kind: 'bet', amount: U, when: at(1) });
    expect(await readPositions(t.db as never)).toEqual([]);
  });

  it('a code that belongs to no Mako Market account enters no one', async () => {
    t = await competitionDb();
    await referrerWith(t, REF, 2);
    await t.client.query(`DELETE FROM users WHERE wallet_address = $1`, [REF]);
    expect(await readPositions(t.db as never)).toEqual([]);
  });

  it('a marketing tag that starts with r- is not a referral', async () => {
    t = await competitionDb();
    await account(t, { wallet: REF });
    for (const w of [addr('b1'), addr('b2')]) {
      await account(t, { wallet: w, ref: 'r-launch' });
      await event(t, { actor: w, market: 1, kind: 'bet', amount: U, when: at(1) });
    }
    expect(await readPositions(t.db as never)).toEqual([]);
  });

  it('an entrant with nothing counted yet is still listed', async () => {
    t = await competitionDb();
    await referrerWith(t, REF, 2);
    expect(await readPositions(t.db as never)).toEqual([{ actor: REF, market: null, yes: 0n, no: 0n, claimed: 0n }]);
  });
});

describe('what counts', () => {
  it('counts bets and claims inside [START, END) only', async () => {
    t = await competitionDb();
    await referrerWith(t, REF, 2);
    await event(t, { actor: REF, market: 5, kind: 'bet', amount: 2n * U, when: at(0), yes: true }); // at START: in
    await event(t, { actor: REF, market: 5, kind: 'bet', amount: U, when: at(3), yes: false });
    await event(t, { actor: REF, market: 5, kind: 'claim', amount: 3n * U, when: at(14 * 24 - 1) }); // last hour: in
    await event(t, { actor: REF, market: 6, kind: 'bet', amount: U, when: at(14 * 24) }); // at END: out
    await event(t, { actor: REF, market: 5, kind: 'claim', amount: 9n * U, when: at(14 * 24 + 1) }); // after END: out
    expect(await readPositions(t.db as never)).toEqual([{ actor: REF, market: '5', yes: 2n * U, no: U, claimed: 3n * U }]);
  });

  it('leaves out a pool the player first bet on before the start: its later bets and claims too', async () => {
    t = await competitionDb();
    await referrerWith(t, REF, 2);
    await event(t, { actor: REF, market: 7, kind: 'bet', amount: U, when: at(-1) });
    await event(t, { actor: REF, market: 7, kind: 'bet', amount: U, when: at(1) });
    await event(t, { actor: REF, market: 7, kind: 'claim', amount: 5n * U, when: at(2) });
    expect(await readPositions(t.db as never)).toEqual([{ actor: REF, market: null, yes: 0n, no: 0n, claimed: 0n }]);
  });

  it('ignores another contract and another player', async () => {
    t = await competitionDb();
    await referrerWith(t, REF, 2);
    await event(t, { actor: REF, market: 8, kind: 'bet', amount: U, when: at(1), contract: addr('cc') });
    await event(t, { actor: addr('dd'), market: 8, kind: 'bet', amount: U, when: at(1) });
    expect(await readPositions(t.db as never)).toEqual([{ actor: REF, market: null, yes: 0n, no: 0n, claimed: 0n }]);
  });
});

const row = (market: string | null, yes: bigint, no: bigint, claimed: bigint, actor = 'p'): PositionRow => ({ actor, market, yes, no, claimed });

describe('foldPositions', () => {
  it('settles YES and NO pools per pool, never REFUND, unresolved or a failed read', () => {
    const outcomes = new Map([
      ['1', { resolved: true, outcome: Outcome.YES }],
      ['2', { resolved: true, outcome: Outcome.NO }],
      ['3', { resolved: true, outcome: Outcome.REFUND }],
      ['4', { resolved: false, outcome: Outcome.UNRESOLVED }],
      ['5', null],
      ['6', { resolved: true, outcome: Outcome.YES }],
      ['7', { resolved: true, outcome: Outcome.YES }],
    ]);
    const s = foldPositions(
      [
        row('1', 2n * U, 0n, 3n * U), // won YES
        row('2', U, 0n, 0n), // lost on NO
        row('3', U, 0n, U), // refund: not settled
        row('4', U, 0n, 0n), // open: not settled
        row('5', U, 0n, 0n), // failed read: not settled, not a loss
        row('6', 3n * U, 2n * U, 0n), // hedged, more on the winner: won
        row('7', 2n * U, 2n * U, 0n), // hedged evenly: lost
        row(null, 0n, 0n, 0n),
      ],
      outcomes,
    ).get('p');
    expect(s).toEqual({ actor: 'p', net: 4n * U - 15n * U, won: 2, settled: 4 });
  });

  it('gives an entrant with nothing counted a zero score', () => {
    expect(foldPositions([row(null, 0n, 0n, 0n)], new Map()).get('p')).toEqual({ actor: 'p', net: 0n, won: 0, settled: 0 });
  });
});

describe('rankEntrants', () => {
  const s = (actor: string, net: bigint, won: number, settled: number): EntrantScore => ({ actor, net, won, settled });

  it('ranks only from the minimum, by net, and lists the rest by settled pools', () => {
    const { ranked, unranked } = rankEntrants([s('a', 5n, 1, 5), s('b', 9n, 0, 5), s('c', 99n, 4, 4), s('d', 0n, 0, 0), s('e', 1n, 1, 2)], 5);
    expect(ranked.map((x) => x.actor)).toEqual(['b', 'a']);
    expect(unranked.map((x) => x.actor)).toEqual(['c', 'e', 'd']);
  });

  it('breaks a net tie on the exact win rate, then settled pools, then the address', () => {
    // 2/3 beats 3/5; 3/6 and 5/10 are equal, so 10 settled beats 6; identical scores fall back to the address.
    const { ranked } = rankEntrants([s('x5', 1n, 3, 5), s('x3', 1n, 2, 3), s('y6', 1n, 3, 6), s('y10', 1n, 5, 10), s('zb', 0n, 1, 3), s('za', 0n, 1, 3)], 3);
    expect(ranked.map((x) => x.actor)).toEqual(['x3', 'x5', 'y10', 'y6', 'za', 'zb']);
  });
});

describe('readCompetitionStandings', () => {
  it('returns names and amounts only, never an email or a user id', async () => {
    t = await competitionDb();
    await referrerWith(t, REF, 2);
    await t.client.query(`UPDATE users SET display_name = 'shark', email = 'secret@example.com' WHERE wallet_address = $1`, [REF]);
    for (let m = 10; m < 15; m += 1) {
      await event(t, { actor: REF, market: m, kind: 'bet', amount: U, when: at(1) });
      chain.outcomes.set(String(m), { resolved: true, outcome: m === 14 ? Outcome.NO : Outcome.YES });
    }
    await event(t, { actor: REF, market: 10, kind: 'claim', amount: 2n * U, when: at(5) });
    const out = await readCompetitionStandings(t.db as never);
    expect(out.ranked).toEqual([{ actor: REF, displayName: 'shark', avatarUrl: null, net: String(-3n * U), won: 4, settled: 5 }]);
    expect(out.unranked).toEqual([]);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain('secret');
    expect(wire).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
