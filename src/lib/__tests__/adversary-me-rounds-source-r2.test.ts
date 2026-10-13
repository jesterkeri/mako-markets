// Adversary r2 on 28bde34 + 1aa6f31 (the 0-rounds source excuse, and Me's own ENVIO_ROUNDS_GRAPHQL_URL). Spec points
// from the brief: (1) only a 0-rounds head with NO source row is excused, a wrong, malformed or extra row is refused at
// 0 rounds too; (2) a 0-rounds answer cannot hide a claim (the browser reads every round on chain within
// ME_ROUNDS_MAX_UNINDEXED, or is unavailable); (3) Me with ENVIO_ROUNDS_GRAPHQL_URL unset is 503 not_configured, and
// ENVIO_GRAPHQL_URL alone does not configure it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ME_ROUNDS_MAX_UNINDEXED, parseMeRoundsDiscovery, planMeRoundReads } from '@/lib/me-rounds-discovery';
import { envioFetch, fakeEnvio, RIGHT_SOURCE, type FakeEnvio } from './helpers/fake-envio';

const URL_ = 'https://indexer.test/v1/graphql';
const A = '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550';
const PREVIEW = '0x00000000000000000000000000000000000000d4';

let env: FakeEnvio;
let GET: (req: Request) => Promise<Response>;

/// Answers the head query with exactly `data` (the fake would otherwise add a source row), everything else from the model.
function headAnswers(data: Record<string, unknown>) {
  // The fake adds `source` to an answer without RoundsSource; undefined makes JSON drop the key, so it stays missing.
  if (!('RoundsSource' in data)) env.source = undefined;
  env.override = (op) => (op === 'head' ? Response.json({ data }) : null);
}

beforeEach(async () => {
  vi.resetModules();
  env = fakeEnvio();
  process.env.ENVIO_ROUNDS_GRAPHQL_URL = URL_;
  delete process.env.ENVIO_GRAPHQL_URL;
  vi.spyOn(globalThis, 'fetch').mockImplementation(envioFetch(env, URL_) as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ GET } = await import('@/app/api/me/rounds/route'));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
  delete process.env.ENVIO_GRAPHQL_URL;
});

const call = async () => {
  const res = await GET(new Request(`http://localhost/api/me/rounds?account=${A}`));
  return { status: res.status, body: await res.json() };
};

describe('spec 1: at 0 rounds only an ABSENT source row is excused', () => {
  it('no GlobalStats row and no source row: 0 rounds, nothing else asked', async () => {
    headAnswers({ GlobalStats: [], RoundsSource: [] });
    expect(await call()).toEqual({ status: 200, body: { roundIds: [], indexedThrough: '0', head: null } });
  });

  it.each([
    ['RoundsSource null', { GlobalStats: [{ rounds: 0 }], RoundsSource: null }],
    ['RoundsSource key missing', { GlobalStats: [{ rounds: 0 }] }],
    ['RoundsSource [null]', { GlobalStats: [{ rounds: 0 }], RoundsSource: [null] }],
    ['RoundsSource {} (object, not list)', { GlobalStats: [{ rounds: 0 }], RoundsSource: {} }],
    ['two right rows', { GlobalStats: [{ rounds: 0 }], RoundsSource: [...RIGHT_SOURCE, ...RIGHT_SOURCE] }],
    ['right + foreign', { GlobalStats: [{ rounds: 0 }], RoundsSource: [...RIGHT_SOURCE, { sourceChain: 10143, address: PREVIEW }] }],
    ['conflict row', { GlobalStats: [{ rounds: 0 }], RoundsSource: [{ sourceChain: 10143, address: 'conflict' }] }],
    ['right address, other chain', { GlobalStats: [{ rounds: 0 }], RoundsSource: [{ sourceChain: 1, address: RIGHT_SOURCE[0].address }] }],
    ['no GlobalStats, foreign row', { GlobalStats: [], RoundsSource: [{ sourceChain: 10143, address: PREVIEW }] }],
  ])('0 rounds, %s: refused 502 wrong_source', async (_name, data) => {
    headAnswers(data);
    expect(await call()).toEqual({ status: 502, body: { error: 'wrong_source' } });
  });

  it('GlobalStats key missing with no source row: refused, never 0 rounds', async () => {
    headAnswers({ RoundsSource: [] });
    expect((await call()).status).toBe(502);
  });

  it('an indexer built before RoundsSource (Hasura: unknown field) with many rounds: refused, never 0 rounds', async () => {
    env.override = () => Response.json({ errors: [{ message: "field 'RoundsSource' not found in type: 'query_root'" }] });
    expect(await call()).toEqual({ status: 502, body: { error: 'indexer_unavailable' } });
  });

  it('no source row while claiming 150 rounds: refused', async () => {
    headAnswers({ GlobalStats: [{ rounds: 150 }], RoundsSource: [] });
    expect(await call()).toEqual({ status: 502, body: { error: 'wrong_source' } });
  });
});

describe('spec 2: a foreign 0-rounds, no-source answer cannot hide a claim', () => {
  const zero = parseMeRoundsDiscovery({ roundIds: [], indexedThrough: '0', head: null });

  it('parses as indexedThrough 0, head null', () => {
    expect(zero).toEqual({ roundIds: [], indexedThrough: 0n, head: null });
  });

  it('100 rounds on chain: every round 1..100 is read on chain', () => {
    const plan = planMeRoundReads(100n, zero!);
    expect(plan).toEqual({ ok: true, ids: Array.from({ length: 100 }, (_, i) => BigInt(i + 1)) });
  });

  it('exactly the cap on chain is read in full, one past it is unavailable', () => {
    const at = planMeRoundReads(BigInt(ME_ROUNDS_MAX_UNINDEXED), zero!);
    expect(at.ok && at.ids.length).toBe(ME_ROUNDS_MAX_UNINDEXED);
    expect(planMeRoundReads(BigInt(ME_ROUNDS_MAX_UNINDEXED + 1), zero!)).toEqual({ ok: false, reason: 'indexer_behind' });
  });

  it('150 rounds on chain: unavailable, never a partial list', () => {
    expect(planMeRoundReads(150n, zero!)).toEqual({ ok: false, reason: 'indexer_behind' });
  });

  it('a cached 0-rounds answer while the chain grows past the cap: unavailable', async () => {
    headAnswers({ GlobalStats: [], RoundsSource: [] });
    const first = await call();
    env.override = null;
    env.globalRounds = 130;
    env.source = RIGHT_SOURCE;
    const second = await call(); // within CACHE_MS: the cached 0-rounds answer
    expect(second).toEqual(first);
    expect(planMeRoundReads(130n, parseMeRoundsDiscovery(second.body)!)).toEqual({ ok: false, reason: 'indexer_behind' });
  });
});

describe('spec 3: Me reads only ENVIO_ROUNDS_GRAPHQL_URL', () => {
  async function reload() {
    vi.resetModules();
    ({ GET } = await import('@/app/api/me/rounds/route'));
  }

  it('unset, with ENVIO_GRAPHQL_URL (the /stats indexer) set: 503 not_configured, no request', async () => {
    delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
    process.env.ENVIO_GRAPHQL_URL = URL_;
    await reload();
    expect(await call()).toEqual({ status: 503, body: { error: 'not_configured' } });
    expect(env.log).toEqual([]);
  });

  it.each(['', '   ', '\n\t '])('whitespace-only %j: 503 not_configured', async (v) => {
    process.env.ENVIO_ROUNDS_GRAPHQL_URL = v;
    await reload();
    expect(await call()).toEqual({ status: 503, body: { error: 'not_configured' } });
  });
});
