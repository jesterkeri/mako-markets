// A friend's code typed on the Me page (owner change 2026-10-23) and the caller's own counts (slice 2): every refusal
// rule, the one-write guarantee, and that a referral entered by code counts in the standings exactly like one from
// the link. Plus the copy guard for every word the competition shows.

import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('@/lib/aa-public-client', () => ({ getAaPublicClient: () => ({ multicall: async () => [] }) }));

import { COMPETITION_COPY, COMPETITION_END, COMPETITION_START, referralProgress } from '@/lib/competition/config';
import { referralCounts, setReferrer } from '@/lib/competition/referrals';
import { readPositions } from '@/lib/competition/standings';
import type { TestDb } from '@/lib/leaderboard/__tests__/test-db';

import { account, addr, at, codeOf, competitionDb, event } from './db';

let t: TestDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const REF = addr('a1');
const refOf = async (db: TestDb, id: string) => (await db.client.query<{ ref: string | null }>(`SELECT ref FROM users WHERE id = $1`, [id])).rows[0].ref;

describe('setReferrer', () => {
  it('records a registered friend’s code on a new account with no tag, or replaces a marketing tag', async () => {
    t = await competitionDb();
    await account(t, { safe: getAddress(REF) }); // the referrer is an email account: its Safe is stored checksummed
    const fresh = await account(t, { wallet: addr('b1') });
    const tagged = await account(t, { wallet: addr('b2'), ref: 'post3', createdAt: at(0) });
    expect(await setReferrer(t.db as never, fresh, codeOf(REF))).toEqual({ ok: true });
    expect(await setReferrer(t.db as never, tagged, codeOf(REF))).toEqual({ ok: true });
    expect(await refOf(t, fresh)).toBe(codeOf(REF));
    expect(await refOf(t, tagged)).toBe(codeOf(REF));
  });

  it('refuses a code no account has, the caller’s own code, a second inviter, and an account from before the start', async () => {
    t = await competitionDb();
    await account(t, { wallet: REF });
    const me = await account(t, { wallet: addr('b1') });
    expect(await setReferrer(t.db as never, me, codeOf(addr('c1')))).toEqual({ ok: false, error: 'invalid' });
    expect(await setReferrer(t.db as never, me, codeOf(addr('b1')))).toEqual({ ok: false, error: 'own' });
    const invited = await account(t, { wallet: addr('b2'), ref: codeOf(addr('c2')) });
    expect(await setReferrer(t.db as never, invited, codeOf(REF))).toEqual({ ok: false, error: 'already' });
    expect(await refOf(t, invited)).toBe(codeOf(addr('c2')));
    const old = await account(t, { wallet: addr('b3'), createdAt: new Date(COMPETITION_START.getTime() - 1) });
    expect(await setReferrer(t.db as never, old, codeOf(REF))).toEqual({ ok: false, error: 'too_old' });
    expect(await refOf(t, me)).toBeNull();
    expect(await refOf(t, old)).toBeNull();
  });

  it('writes once: a second call, or a concurrent one, is refused and the first code stays', async () => {
    t = await competitionDb();
    await account(t, { wallet: REF });
    await account(t, { wallet: addr('a2') });
    const me = await account(t, { wallet: addr('b1') });
    const both = await Promise.all([setReferrer(t.db as never, me, codeOf(REF)), setReferrer(t.db as never, me, codeOf(addr('a2')))]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'already' }]);
    const first = await refOf(t, me);
    expect(await setReferrer(t.db as never, me, codeOf(REF))).toEqual({ ok: false, error: 'already' });
    expect(await refOf(t, me)).toBe(first);
  });

  it('a referral entered by code counts in the standings exactly like one from the link', async () => {
    t = await competitionDb();
    await account(t, { wallet: REF });
    await account(t, { wallet: addr('b1'), ref: codeOf(REF) }); // from the link
    await event(t, { actor: addr('b1'), market: 1, kind: 'bet', amount: 100_000n, when: at(1) });
    const typed = await account(t, { safe: getAddress(addr('b2')) }); // signed up on another device
    await event(t, { actor: addr('b2'), market: 1, kind: 'bet', amount: 100_000n, when: at(2) });
    expect(await readPositions(t.db as never)).toEqual([]); // one referral so far
    expect(await setReferrer(t.db as never, typed, codeOf(REF))).toEqual({ ok: true });
    expect((await readPositions(t.db as never)).map((r) => r.actor)).toEqual([REF]);
  });
});

describe('referralCounts', () => {
  it('counts link and code sign-ups together, and those who bet before the end; never a self-referral', async () => {
    t = await competitionDb();
    const me = await account(t, { wallet: REF });
    await account(t, { wallet: addr('b1'), ref: codeOf(REF) });
    await event(t, { actor: addr('b1'), market: 1, kind: 'bet', amount: 100_000n, when: at(1) });
    await account(t, { wallet: addr('b2'), ref: codeOf(REF) }); // joined, no bet
    await account(t, { wallet: addr('b3'), ref: codeOf(REF) });
    await event(t, { actor: addr('b3'), market: 1, kind: 'bet', amount: 100_000n, when: COMPETITION_END }); // too late
    await account(t, { wallet: `${REF.slice(0, 32)}ffffffffff`, ref: codeOf(REF) }); // self-referral
    await account(t, { wallet: addr('b4'), ref: codeOf(addr('c1')) }); // someone else's friend
    expect(await referralCounts(t.db as never, me, codeOf(REF))).toEqual({ joined: 3, qualified: 1, canAddInviter: true });
  });

  it('says whether the caller may still add an inviter', async () => {
    t = await competitionDb();
    const invited = await account(t, { wallet: addr('b1'), ref: codeOf(REF) });
    const old = await account(t, { wallet: addr('b2'), createdAt: at(-1) });
    const tagged = await account(t, { wallet: addr('b3'), ref: 'post3' });
    expect((await referralCounts(t.db as never, invited, codeOf(addr('b1')))).canAddInviter).toBe(false);
    expect((await referralCounts(t.db as never, old, codeOf(addr('b2')))).canAddInviter).toBe(false);
    expect((await referralCounts(t.db as never, tagged, codeOf(addr('b3')))).canAddInviter).toBe(true);
  });
});

describe('competition copy', () => {
  const strings = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];

  it('has no em dash and no we, our or us, and says Mako Market, never Mako Markets', () => {
    const all = [...strings(COMPETITION_COPY), ...strings(referralProgress(3, 1))];
    expect(all.length).toBeGreaterThan(20);
    for (const s of all) {
      expect(s, s).not.toContain('—');
      expect(s, s).not.toMatch(/\b(we|our|us)\b/i);
      expect(s, s).not.toMatch(/Mako Markets/);
    }
  });

  it('shows the window in UTC, END fourteen days after START', () => {
    expect(COMPETITION_END.getTime() - COMPETITION_START.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    expect(COMPETITION_COPY.rules[0]).toMatch(/^Runs from \d{4}-\d\d-\d\d \d\d:00 to \d{4}-\d\d-\d\d \d\d:00 UTC\.$/);
    expect(referralProgress(3, 2)).toEqual({ joined: '3 signed up with your link or code', qualified: '2 of them placed a bet', entered: true });
    expect(referralProgress(1, 1).entered).toBe(false);
  });
});
