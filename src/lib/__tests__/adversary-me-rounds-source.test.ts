// Adversary on 50f5a2a (Codex ME_ROUNDS R3). The route's own contract (route.ts: "head null iff 0 rounds") and the
// existing test 'no GlobalStats row yet, or 0 rounds' (api-me-rounds-route.test.ts) answer 200 with head null when the
// indexer has no rounds. That test passes only because the fake adds a RoundsSource row to every answer. The real
// handler writes RoundsSource only from RoundScheduled (indexer/src/handlers/MakoRoundsV1.ts noteSource), so a real
// indexer with 0 rounds has GlobalStats.rounds 0 and NO RoundsSource row (indexer/src/adversary-source.test.ts proves
// that state). Here the fake answers what that indexer answers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envioFetch, fakeEnvio, type FakeEnvio } from './helpers/fake-envio';

const URL_ = 'https://indexer.test/v1/graphql';
const A = '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550';

let env: FakeEnvio;
let GET: (req: Request) => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  env = fakeEnvio();
  process.env.ENVIO_ROUNDS_GRAPHQL_URL = URL_;
  vi.spyOn(globalThis, 'fetch').mockImplementation(envioFetch(env, URL_) as typeof fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ GET } = await import('@/app/api/me/rounds/route'));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
});

describe('adversary: the right indexer, before its first round', () => {
  it('0 rounds and no RoundsSource row yet (as the real handler leaves it): 200, head null, as route.ts documents', async () => {
    env.globalRounds = 0;
    env.source = []; // the real indexer: no RoundScheduled yet, so no row
    const res = await GET(new Request(`http://localhost/api/me/rounds?account=${A}`));
    const body = await res.json();
    expect({ status: res.status, body }).toEqual({ status: 200, body: { roundIds: [], indexedThrough: '0', head: null } });
  });
});
