// #214 S1 unit and pglite tests: copy (§6), preferences (§3.4: parsePrefs, prefOn, prefsSet over 11 starting values),
// dedupe keys.
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { render } from '@/lib/notifications/copy';
import { poolCreatorKey, poolResultKey, replyKey, roundResultKey } from '@/lib/notifications/keys';
import {
  KIND_DEFAULTS,
  NOTIFICATION_KINDS,
  parsePrefs,
  parsePrefsPatch,
  prefOn,
  prefsSet,
  type PrefsPatch,
} from '@/lib/notifications/prefs';

import { createNotifyDb, walletAccount, type NotifyDb } from './harness';

const ALL_DATA: { kind: string; data: unknown }[] = [
  { kind: 'claim', data: { t: 'pool', id: '123', outcome: 'yes', why: 'won' } },
  { kind: 'claim', data: { t: 'pool', id: '123', outcome: 'refund', why: 'refund' } },
  { kind: 'claim', data: { t: 'pool', id: '123', outcome: 'no', why: 'creator' } },
  { kind: 'result', data: { t: 'pool', id: '123', outcome: 'no', side: 'yes' } },
  { kind: 'claim', data: { t: 'round', id: '45', outcome: 'up', why: 'won' } },
  ...['one_sided', 'tie', 'no_price'].map((reason) => ({ kind: 'claim', data: { t: 'round', id: '45', outcome: 'refund', why: 'refund', reason } })),
  { kind: 'result', data: { t: 'round', id: '45', outcome: 'down', side: 'up' } },
  { kind: 'reply', data: { poolId: '123', count: 1 } },
  { kind: 'reply', data: { poolId: '123', count: 3 } },
  { kind: 'closing', data: { poolId: '123', closesAt: '2026-10-22T14:05:00Z' } },
  { kind: 'round_start', data: { roundId: '45', startsAt: '2026-10-22T16:01:00Z', entriesCloseAt: '2026-10-22T16:00:00Z' } },
  { kind: 'price', data: { symbol: 'BTC', direction: 'above', target: 70000 } },
];

describe('render (§6)', () => {
  it('renders every kind and outcome with the plan copy', () => {
    const out = ALL_DATA.map((n) => render(n, { timeZone: 'UTC' }));
    expect(out).toEqual([
      { title: 'You won', body: 'Pool #123 settled YES. Your winnings are ready to claim on Me.', href: '/me' },
      { title: 'Refund ready', body: 'Pool #123 was refunded. Your stake is ready to claim on Me.', href: '/me' },
      { title: 'Creator earnings ready', body: 'Pool #123 settled. Your creator earnings are ready to claim on Me.', href: '/me' },
      { title: 'Pool settled', body: 'Pool #123 settled NO. Your YES position did not win.', href: '/pools/123' },
      { title: 'You won round #45', body: 'BTC went up. Your winnings are ready to claim on Me.', href: '/me' },
      { title: 'Round #45 refunded', body: 'Only one side had entries. Your stake is ready to claim on Me.', href: '/me' },
      { title: 'Round #45 refunded', body: 'The close price matched the start price. Your stake is ready to claim on Me.', href: '/me' },
      { title: 'Round #45 refunded', body: 'No price report arrived in time. Your stake is ready to claim on Me.', href: '/me' },
      { title: 'Round #45 settled', body: 'BTC went down. Your UP entry did not win.', href: '/rounds/45' },
      { title: 'New reply', body: 'Someone replied to your comment on pool #123.', href: '/pools/123' },
      { title: '3 new replies', body: 'Someone replied to your comment on pool #123.', href: '/pools/123' },
      { title: 'Betting closes soon', body: 'Betting on pool #123 closes at 14:05.', href: '/pools/123' },
      { title: 'Round starts soon', body: 'Entries for round #45 close at 16:00.', href: '/rounds/45' },
      { title: 'BTC above $70,000', body: 'BTC traded at or above $70,000 on Coinbase. This alert is now off.', href: '/notifications' },
    ]);
  });

  it('copy rules: no we/our/us/team, no em dash, the brand singular', () => {
    const texts = [...ALL_DATA.map((n) => render(n, { timeZone: 'UTC' })), render({ kind: 'nope', data: null })].flatMap((r) => [r.title, r.body]);
    for (const s of texts) {
      expect(s).not.toMatch(/\b(we|our|us|team)\b/i);
      expect(s).not.toContain('—');
      expect(s).not.toMatch(/Mako Markets/);
    }
  });

  it('malformed data never throws and never renders an unvalidated id', () => {
    for (const data of [null, [], 'x', { t: 'pool', id: '1; DROP' }, { t: 'pool', id: '9'.repeat(79), outcome: 'yes', why: 'won' }, { poolId: '<b>' }]) {
      for (const kind of ['claim', 'result', 'reply', 'closing', 'round_start', 'price', 'other']) {
        const r = render({ kind, data });
        expect(r.href.startsWith('/')).toBe(true);
        expect(r.body).not.toContain('DROP');
        expect(r.body).not.toContain('<b>');
      }
    }
  });
});

describe('dedupe keys', () => {
  it('fit the 200-byte CHECK at maximum width', () => {
    const c = '0x' + 'f'.repeat(40);
    const id = '9'.repeat(78);
    for (const k of [poolResultKey(c, id), poolCreatorKey(c, id), roundResultKey(c, id), replyKey('00000000-0000-0000-0000-000000000000')]) {
      expect(Buffer.byteLength(k)).toBeLessThanOrEqual(200);
    }
    expect(poolResultKey('0xABC', '1')).toBe('pool:0xabc:1:result');
  });
});

describe('parsePrefs and parsePrefsPatch', () => {
  it('malformed values give the defaults, and never throw', () => {
    const defaults = { kinds: { ...KIND_DEFAULTS }, email: true };
    for (const raw of [null, undefined, 1, 'x', [], {}, { kinds: [] }, { kinds: 'x' }, { kinds: { claim: 'yes' } }, { email: 'no' }]) {
      expect(parsePrefs(raw)).toEqual(defaults);
    }
    expect(parsePrefs({ kinds: { claim: false, round_start: true }, email: false })).toEqual({ kinds: { ...KIND_DEFAULTS, claim: false, round_start: true }, email: false });
  });

  it('a patch takes only the six kinds and booleans, and at least one field', () => {
    expect(parsePrefsPatch({ kinds: { reply: false } })).toEqual({ kinds: { reply: false } });
    expect(parsePrefsPatch({ email: false })).toEqual({ email: false });
    for (const bad of [null, [], {}, { kinds: {} }, { kinds: { nope: true } }, { kinds: { reply: 'false' } }, { email: 0 }, { kinds: [] }]) {
      expect(parsePrefsPatch(bad)).toBeNull();
    }
  });
});

describe('prefsSet over every starting value (pglite)', () => {
  let t: NotifyDb | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });

  const STARTS: (string | null)[] = [
    null,
    '{}',
    '{"kinds":{"claim":"yes"}}',
    '{"kinds":{"claim":1}}',
    '{"kinds":{"claim":null}}',
    '{"kinds":[]}',
    '[]',
    '"x"',
    '{"email":"no"}',
    'null',
    '{"kinds":{"claim":false,"result":false}}',
  ];
  const PATCHES: PrefsPatch[] = [{ kinds: { reply: false } }, { email: false }, { kinds: { round_start: true } }];

  async function read(id: string) {
    const cols = NOTIFICATION_KINDS.map((k) => sql`${prefOn(k)} AS ${sql.raw(k)}`);
    const r = (await t!.db.execute(sql`SELECT u.notification_prefs AS raw, ${sql.join(cols, sql`, `)} FROM users u WHERE u.id = ${id}::uuid`)) as unknown as {
      rows: Record<string, unknown>[];
    };
    const row = r.rows[0];
    const viaSql = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, row[k]]));
    return { viaSql, parsed: parsePrefs(row.raw) };
  }

  it('changes exactly the named switch over 11 starting values and 3 patches; SQL and TypeScript readers agree', async () => {
    t = await createNotifyDb();
    let k = 0;
    expect(STARTS).toHaveLength(11);
    for (const start of STARTS) {
      for (const patch of PATCHES) {
        k += 1;
        const id = await walletAccount(t, `0x${(0xa000 + k).toString(16).padStart(40, '0')}`);
        if (start !== null) await t.client.query(`UPDATE users SET notification_prefs = $2::jsonb WHERE id = $1`, [id, start]);
        const before = await read(id);
        expect(before.viaSql).toEqual(before.parsed.kinds);
        await t.db.execute(sql`UPDATE users SET notification_prefs = ${prefsSet(patch)} WHERE id = ${id}::uuid`);
        const after = await read(id);
        expect(after.viaSql).toEqual(after.parsed.kinds);
        const expected = { kinds: { ...before.parsed.kinds, ...(patch.kinds ?? {}) }, email: patch.email ?? before.parsed.email };
        expect(after.parsed).toEqual(expected);
        if (start === '{"kinds":{"claim":false,"result":false}}') {
          expect(after.parsed.kinds.claim).toBe(false);
          expect(after.parsed.kinds.result).toBe(false);
        }
      }
    }
  });

  it('two patches in a row keep both', async () => {
    t = await createNotifyDb();
    const id = await walletAccount(t, '0x000000000000000000000000000000000000b0b1');
    await t.db.execute(sql`UPDATE users SET notification_prefs = ${prefsSet({ kinds: { reply: false } })} WHERE id = ${id}::uuid`);
    await t.db.execute(sql`UPDATE users SET notification_prefs = ${prefsSet({ kinds: { round_start: true } })} WHERE id = ${id}::uuid`);
    const r = await t.client.query<{ p: unknown }>(`SELECT notification_prefs AS p FROM users WHERE id = $1`, [id]);
    expect(parsePrefs(r.rows[0].p).kinds).toMatchObject({ reply: false, round_start: true });
  });
});
