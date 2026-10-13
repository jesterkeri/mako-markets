// GET /api/me/rounds (Codex ME_ROUNDS R1): the round ids one account needs, from the indexer. Validation, lower-casing,
// paging to the end whatever the server's row cap, creator rounds, Active rounds, the read order that makes the answer
// complete, a clear error for every failure (never an empty or partial list), and the short per-account cache. Also
// (Codex ME_ROUNDS R2) the head round's fingerprint, which the browser checks against the chain before trusting the rest.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerEnvio, envioFetch, FAKE_OPEN, FAKE_START, fakeEnvio, type FakeEnvio } from './helpers/fake-envio';

const URL_ = 'https://indexer.test/v1/graphql';
const A = '0xE490ab83C7f247bEC7D5e04Ce04BC48d6609b550';
const a = A.toLowerCase();
const OTHER = '0x00000000000000000000000000000000000000b2';
/// The indexer's head round `n`, hosted by someone else and settled, so it adds nothing to the account's lists.
const headRound = (n: number) => ({ id: String(n), creator: OTHER, status: 'Up' as const });
/// The fingerprint the route answers for that round.
const H = (n: number, creator: string = OTHER) => ({ id: String(n), openTime: FAKE_OPEN, startTime: FAKE_START, creator });
type Wire = { roundIds: string[]; indexedThrough: string; head: { id: string; openTime: string; startTime: string; creator: string } | null };

let env: FakeEnvio;
let GET: (req: Request) => Promise<Response>;
let PAGE_SIZE: number;
let MAX_ROWS: number;

beforeEach(async () => {
  vi.resetModules();
  env = fakeEnvio();
  process.env.ENVIO_ROUNDS_GRAPHQL_URL = URL_;
  vi.spyOn(globalThis, 'fetch').mockImplementation(envioFetch(env, URL_) as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ GET } = await import('@/app/api/me/rounds/route'));
  ({ PAGE_SIZE, MAX_ROWS } = await import('@/lib/me-rounds-indexer'));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
});

const call = (qs: string) => GET(new Request(`http://localhost/api/me/rounds${qs}`));
async function ok(qs = `?account=${A}`) {
  const res = await call(qs);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return (await res.json()) as Wire;
}

describe('validation', () => {
  it.each([
    ['', 'missing'],
    ['?account=', 'empty'],
    ['?account=0x1234', 'short'],
    [`?account=${a}00`, 'long'],
    [`?account=${a.slice(2)}`, 'no 0x'],
    [`?account=0x${'g'.repeat(40)}`, 'not hex'],
    [`?account=${a}&account=${OTHER}`, 'two accounts'],
    [`?account=%20${a}`, 'padded'],
  ])('%s (%s) is 400 bad_account and never reaches the indexer', async (qs) => {
    const res = await call(qs);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_account' });
    expect(env.log).toEqual([]);
  });

  it('any letter case is accepted and queried lower-case', async () => {
    env.globalRounds = 3;
    env.rounds = [{ id: '2', creator: OTHER, status: 'Up' }, headRound(3)];
    env.entries = [{ id: '10_1', round_id: '2', wallet_id: a }];
    for (const form of [A, a, `0x${a.slice(2).toUpperCase()}`]) {
      vi.resetModules();
      ({ GET } = await import('@/app/api/me/rounds/route'));
      env.log.length = 0;
      expect(await ok(`?account=${form}`)).toEqual({ roundIds: ['2'], indexedThrough: '3', head: H(3) });
      const accounts = env.log.flatMap((l) => [l.variables.wallet, l.variables.creator]).filter((v) => v !== undefined);
      expect(accounts.length).toBeGreaterThanOrEqual(2);
      expect(new Set(accounts)).toEqual(new Set([a]));
    }
  });
});

describe('what it answers', () => {
  it('entered, created and indexer-Active rounds, ascending and once each, with the indexer head', async () => {
    env.globalRounds = 40;
    env.rounds = [
      { id: '7', creator: a, status: 'Up' },
      { id: '9', creator: OTHER, status: 'Down' },
      { id: '12', creator: OTHER, status: 'Refunded' },
      { id: '31', creator: OTHER, status: 'Active' },
      { id: '40', creator: a, status: 'Active' },
    ];
    env.entries = [
      { id: '100_0', round_id: '12', wallet_id: a },
      { id: '101_3', round_id: '12', wallet_id: a },
      { id: '102_0', round_id: '3', wallet_id: a },
      { id: '103_0', round_id: '9', wallet_id: OTHER },
    ];
    expect(await ok()).toEqual({ roundIds: ['3', '7', '12', '31', '40'], indexedThrough: '40', head: H(40, a) });
  });

  it('a host with no stake: its created round is listed (creator rounds included)', async () => {
    env.globalRounds = 8;
    env.rounds = [{ id: '7', creator: a, status: 'Up' }, headRound(8)];
    expect(await ok()).toEqual({ roundIds: ['7'], indexedThrough: '8', head: H(8) });
  });

  it('no GlobalStats row yet, or 0 rounds: indexedThrough 0 and no head, and no head round is asked for', async () => {
    env.globalRounds = null;
    expect(await ok()).toEqual({ roundIds: [], indexedThrough: '0', head: null });
    expect(env.log.some((l) => l.op === 'headRound')).toBe(false);

    vi.resetModules();
    ({ GET } = await import('@/app/api/me/rounds/route'));
    env.globalRounds = 0;
    env.log.length = 0;
    expect(await ok()).toEqual({ roundIds: [], indexedThrough: '0', head: null });
    expect(env.log.some((l) => l.op === 'headRound')).toBe(false);
  });

  it('reads the head first, then its round, then Active rounds, then entries and created rounds', async () => {
    env.globalRounds = 2;
    env.rounds = [{ id: '1', creator: a, status: 'Active' }, headRound(2)];
    await ok();
    const ops = env.log.map((l) => l.op);
    expect(ops[0]).toBe('head');
    expect(ops[1]).toBe('headRound');
    expect(env.log[1].variables).toEqual({ id: '2' });
    const lastActive = ops.lastIndexOf('active');
    expect(ops.indexOf('active')).toBe(2);
    expect(ops.slice(lastActive + 1).every((o) => o === 'entries' || o === 'created')).toBe(true);
    expect(ops.filter((o) => o === 'entries').length).toBeGreaterThan(0);
    expect(ops.filter((o) => o === 'created').length).toBeGreaterThan(0);
  });
});

describe('paging', () => {
  it('pages with a seek cursor of PAGE_SIZE and reads to an empty page', async () => {
    env.globalRounds = 3000;
    env.rounds = [headRound(3000)];
    env.entries = Array.from({ length: 2500 }, (_, i) => ({ id: `b${String(i).padStart(6, '0')}`, round_id: String(i + 1), wallet_id: a }));
    const body = await ok();
    expect(body.roundIds.length).toBe(2500);
    const pages = env.log.filter((l) => l.op === 'entries');
    expect(pages.map((p) => p.variables.after)).toEqual(['', 'b000999', 'b001999', 'b002499']);
    expect(pages.every((p) => p.variables.limit === PAGE_SIZE)).toBe(true);
  });

  it('a server that caps rows below the limit still yields the whole list (a short page is not the end)', async () => {
    env.rowCap = 7;
    env.globalRounds = 150;
    env.entries = Array.from({ length: 30 }, (_, i) => ({ id: `e${String(i).padStart(3, '0')}`, round_id: String(i + 1), wallet_id: a }));
    env.rounds = [...Array.from({ length: 20 }, (_, i) => ({ id: String(100 + i), creator: a, status: 'Up' as const })), headRound(150)];
    const body = await ok();
    expect(body.roundIds).toEqual([...Array.from({ length: 30 }, (_, i) => String(i + 1)), ...Array.from({ length: 20 }, (_, i) => String(100 + i))]);
  });

  it(`exactly MAX_ROWS entries is answered; one more is 502 too_many_rows, never a partial list`, async () => {
    env.globalRounds = 1;
    env.rounds = [headRound(1)];
    env.entries = Array.from({ length: MAX_ROWS }, (_, i) => ({ id: `e${String(i).padStart(6, '0')}`, round_id: '1', wallet_id: a }));
    expect((await ok()).roundIds).toEqual(['1']);

    vi.resetModules();
    ({ GET } = await import('@/app/api/me/rounds/route'));
    env.entries.push({ id: 'e999999', round_id: '1', wallet_id: a });
    const res = await call(`?account=${A}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'too_many_rows' });
  });

  it('a page that repeats a row (no progress) is an error, not a loop', async () => {
    env.globalRounds = 1;
    env.rounds = [headRound(1)];
    env.override = (op) => (op === 'entries' ? Response.json({ data: { RoundEntry: [{ id: 'x', round_id: '1' }] } }) : null);
    const res = await call(`?account=${A}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'indexer_unavailable' });
    expect(env.log.filter((l) => l.op === 'entries').length).toBe(2);
  });
});

describe('failures are errors, never an empty list', () => {
  it('ENVIO_ROUNDS_GRAPHQL_URL unset: 503 not_configured, no request', async () => {
    delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
    const res = await call(`?account=${A}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not_configured' });
    expect(env.log).toEqual([]);
  });

  const broken: [string, (op: string) => Response | null][] = [
    ['indexer HTTP 500 on the head', (op) => (op === 'head' ? new Response('down', { status: 500 }) : null)],
    ['GraphQL errors on the entries', (op) => (op === 'entries' ? Response.json({ errors: [{ message: 'field not found' }] }) : null)],
    ['a later created page fails', (op) => (op === 'created' ? new Response('x', { status: 503 }) : null)],
    ['Active rounds not a list', (op) => (op === 'active' ? Response.json({ data: { Round: null } }) : null)],
    ['a malformed round id', (op) => (op === 'entries' ? Response.json({ data: { RoundEntry: [{ id: 'e1', round_id: '01' }] } }) : null)],
    ['round id 0', (op) => (op === 'created' ? Response.json({ data: { Round: [{ id: '0' }] } }) : null)],
    ['a non-integer head', (op) => (op === 'head' ? Response.json({ data: { GlobalStats: [{ rounds: 1.5 }] } }) : null)],
    ['two GlobalStats rows', (op) => (op === 'head' ? Response.json({ data: { GlobalStats: [{ rounds: 1 }, { rounds: 2 }] } }) : null)],
    ['a page longer than the limit', (op) => (op === 'active' ? Response.json({ data: { Round: Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({ id: String(i + 1) })) } }) : null)],
  ];
  it.each(broken)('%s: 502 indexer_unavailable', async (_name, override) => {
    env.globalRounds = 5;
    env.rounds = [headRound(5)];
    env.entries = [{ id: 'e1', round_id: '2', wallet_id: a }];
    env.override = override;
    const res = await call(`?account=${A}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'indexer_unavailable' });
  });

  it('the network failing outright: 502, and the log carries the error class only (no URL)', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError(`fetch failed ${URL_}`));
    const res = await call(`?account=${A}`);
    expect(res.status).toBe(502);
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).not.toContain('indexer.test');
  });
});

describe('the head round fingerprint (Codex ME_ROUNDS R2)', () => {
  it('is the indexer round whose id is GlobalStats.rounds: openTime, startTime as decimal strings, creator lower-case', async () => {
    env.globalRounds = 9;
    env.rounds = [
      { id: '8', creator: OTHER, status: 'Up', openTime: '1', startTime: '2' },
      { id: '9', creator: a, status: 'Up', openTime: '1760001234', startTime: '1760002100' },
    ];
    expect((await ok()).head).toEqual({ id: '9', openTime: '1760001234', startTime: '1760002100', creator: a });
  });

  it('a BigInt column Hasura answers as a JSON number (small values) is read exactly', async () => {
    env.globalRounds = 9;
    env.rounds = [{ id: '9', creator: OTHER, status: 'Up', openTime: 1760001234, startTime: 1760002100 }];
    expect((await ok()).head).toEqual({ id: '9', openTime: '1760001234', startTime: '1760002100', creator: OTHER });
  });

  const row = (over: Record<string, unknown>) => (op: string) =>
    op === 'headRound' ? Response.json({ data: { Round: [{ id: '9', openTime: '1760001234', startTime: '1760002100', creator: OTHER, ...over }] } }) : null;
  const unusable: [string, (op: string) => Response | null][] = [
    ['the head round missing (GlobalStats says 9 rounds)', (op) => (op === 'headRound' ? Response.json({ data: { Round: [] } }) : null)],
    ['two head rows', (op) => (op === 'headRound' ? Response.json({ data: { Round: [{ id: '9', openTime: '1', startTime: '2', creator: OTHER }, { id: '9', openTime: '1', startTime: '2', creator: OTHER }] } }) : null)],
    ['a row for another id', row({ id: '8' })],
    ['Round not a list', (op) => (op === 'headRound' ? Response.json({ data: { Round: null } }) : null)],
    ['GraphQL errors (a field the endpoint lacks)', (op) => (op === 'headRound' ? Response.json({ errors: [{ message: "field 'openTime' not found" }] }) : null)],
    ['HTTP 500', (op) => (op === 'headRound' ? new Response('x', { status: 500 }) : null)],
    ['openTime missing', row({ openTime: undefined })],
    ['openTime null', row({ openTime: null })],
    ['openTime negative', row({ openTime: '-1' })],
    ['openTime fractional', row({ openTime: 1.5 })],
    ['openTime a decimal string with a fraction', row({ openTime: '1760001234.0' })],
    ['openTime past uint64', row({ openTime: '18446744073709551616' })],
    ['openTime an unsafe JSON number', row({ openTime: 2 ** 60 })],
    ['startTime with a leading zero', row({ startTime: '01760002100' })],
    ['startTime not a number', row({ startTime: 'soon' })],
    ['creator not an address', row({ creator: '0x1234' })],
    ['creator in mixed case (the indexer stores it lower-case)', row({ creator: '0x00000000000000000000000000000000000000B2' })],
    ['creator missing', row({ creator: undefined })],
  ];
  it.each(unusable)('%s: 502 indexer_unavailable, never an answer without the binding', async (_name, override) => {
    env.globalRounds = 9;
    env.rounds = [{ id: '9', creator: OTHER, status: 'Up' }];
    env.override = override;
    const res = await call(`?account=${A}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'indexer_unavailable' });
  });
});

describe('cache', () => {
  it('one indexer read per account within the cache window; another account reads its own', async () => {
    env.globalRounds = 3;
    env.rounds = [headRound(3)];
    env.entries = [{ id: 'e1', round_id: '2', wallet_id: a }];
    await ok();
    const n = env.log.length;
    expect(await ok(`?account=${a}`)).toEqual({ roundIds: ['2'], indexedThrough: '3', head: H(3) });
    expect(env.log.length).toBe(n);
    await ok(`?account=${OTHER}`);
    expect(env.log.length).toBeGreaterThan(n);
  });

  it('a failure is not cached: the next request reads again', async () => {
    env.globalRounds = 3;
    env.rounds = [headRound(3)];
    env.override = (op) => (op === 'head' ? new Response('down', { status: 500 }) : null);
    expect((await call(`?account=${A}`)).status).toBe(502);
    env.override = null;
    expect(await ok()).toEqual({ roundIds: [], indexedThrough: '3', head: H(3) });
  });
});

// Keep the helper honest: the fake answers as Hasura does for an unknown query.
it('the fake refuses an unscripted query', async () => {
  const res = await answerEnvio(env, JSON.stringify({ query: 'query X { y }' }));
  expect(((await res.json()) as { errors?: unknown }).errors).toBeDefined();
});
