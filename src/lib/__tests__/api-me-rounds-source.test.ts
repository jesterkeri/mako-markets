// GET /api/me/rounds binds every indexer answer to the reviewed Rounds deployment (Codex ME_ROUNDS R3): each query asks
// for the indexer's RoundsSource row, and any page whose source is not exactly MakoRoundsV1 0x9dC0…C2921 on Monad
// testnet makes the whole answer 502 wrong_source, never a list. The two R3 scenarios: a second deployment whose head
// round has the SAME fingerprint (same creator, start time and block time), and a split gateway that answers the head
// from the right indexer and the account's entries from another.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envioFetch, fakeEnvio, RIGHT_SOURCE, type FakeEnvio } from './helpers/fake-envio';

// The route's caller binding and the shared Envio budget are tested on their own (me-rounds-caller / envio-budget
// tests); here every caller is allowed and every call has budget, so this file tests discovery itself.
vi.mock('@/lib/me-rounds-caller', () => ({ authorizeMeRoundsCaller: async () => ({ ok: true }) }));
vi.mock('@/lib/envio-budget', async (orig) => ({ ...(await orig<typeof import('@/lib/envio-budget')>()), reserveEnvioCall: async () => {} }));

const URL_ = 'https://indexer.test/v1/graphql';
const A = '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550';
const HOUSE = '0x00000000000000000000000000000000000000b2';
const PREVIEW = '0x00000000000000000000000000000000000000d4';

let env: FakeEnvio;
let GET: (req: Request) => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  env = fakeEnvio();
  process.env.ENVIO_ROUNDS_GRAPHQL_URL = URL_;
  vi.spyOn(globalThis, 'fetch').mockImplementation(envioFetch(env, URL_) as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ GET } = await import('@/app/api/me/rounds/route'));
  // 100 rounds, the account's old win in #3, a house round at the head.
  env.globalRounds = 100;
  env.rounds = [{ id: '3', creator: HOUSE, status: 'Up' }, { id: '100', creator: HOUSE, status: 'Active' }];
  env.entries = [{ id: 'e3', round_id: '3', wallet_id: A }];
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
});

const call = () => GET(new Request(`http://localhost/api/me/rounds?account=${A}`));
async function refused() {
  const res = await call();
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: 'wrong_source' });
}

describe('every answer names the reviewed Rounds deployment', () => {
  it('the right source on every page: answered, old win included', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roundIds: string[] }).roundIds).toEqual(['3', '100']);
    // Every one of the five query kinds was asked, and each carried the source (the fake adds it to all).
    expect(new Set(env.log.map((l) => l.op))).toEqual(new Set(['head', 'headRound', 'active', 'entries', 'created']));
  });

  it('R3 case 1: a preview deployment whose head fingerprint equals production\'s, without the old entry: refused', async () => {
    // Same creator, same start time, same block time: the head check alone passes. Only the source differs.
    env.entries = [];
    env.source = [{ sourceChain: 10143, address: PREVIEW }];
    await refused();
  });

  it('R3 case 2: a split gateway, the right source for the head, another deployment for the entries: refused', async () => {
    env.entries = [];
    env.sourceFor = (op) => (op === 'entries' ? [{ sourceChain: 10143, address: PREVIEW }] : undefined);
    await refused();
  });

  it('a foreign source on any single page of any list, the second page included: refused', async () => {
    for (const bad of ['head', 'headRound', 'active', 'entries', 'created']) {
      vi.resetModules();
      ({ GET } = await import('@/app/api/me/rounds/route'));
      env.sourceFor = (op) => (op === bad ? [{ sourceChain: 10143, address: PREVIEW }] : undefined);
      await refused();
    }
    // A second page: the right source on the first entries page, a foreign one on the next.
    vi.resetModules();
    ({ GET } = await import('@/app/api/me/rounds/route'));
    env.sourceFor = (op, v) => (op === 'entries' && v.after !== '' ? [{ sourceChain: 10143, address: PREVIEW }] : undefined);
    await refused();
  });

  it.each([
    ['no source row (an indexer built before RoundsSource)', []],
    ['two source rows', [...RIGHT_SOURCE, ...RIGHT_SOURCE]],
    ['another chain', [{ sourceChain: 1, address: RIGHT_SOURCE[0].address }]],
    ['the chain as a string', [{ sourceChain: '10143', address: RIGHT_SOURCE[0].address }]],
    ['the address checksummed rather than as stored', [{ sourceChain: 10143, address: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921' }]],
    ['"conflict"', [{ sourceChain: 10143, address: 'conflict' }]],
    ['null', null],
    ['a row of null', [null]],
  ])('%s: refused', async (_name, rows) => {
    env.source = rows;
    await refused();
  });

  it('an indexer that has seen no round yet has no source row: answered as 0 rounds, and nothing else is asked', async () => {
    env.globalRounds = 0;
    env.source = [];
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roundIds: [], indexedThrough: '0', head: null });
    expect(env.log.map((l) => l.op)).toEqual(['head']);
  });

  it('no source row while claiming rounds: refused', async () => {
    env.source = [];
    await refused();
  });

  it('0 rounds with a FOREIGN source row: refused (only an absent row is excused, never a wrong one)', async () => {
    env.globalRounds = 0;
    env.source = [{ sourceChain: 10143, address: PREVIEW }];
    await refused();
  });

  it('a refused answer is not cached as an answer: the next call with the right source is served', async () => {
    env.source = [{ sourceChain: 10143, address: PREVIEW }];
    await refused();
    env.source = RIGHT_SOURCE;
    expect((await call()).status).toBe(200);
  });
});
