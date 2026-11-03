// Codex CARD_UNFURL R2 F1: the card budgets (avatar-budget.ts) count chain calls, so each budgeted call must be exactly
// one HTTP request, even when the node answers 429 or 5xx (viem's http transport retries those 3 times by default).
// The real pool-share clients over a stubbed fetch, with MONAD_RPC_URL naming another node as in production.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

const TX = '0x29e9f9a7853b200e127c3d3514549231c2bdd75596b7b82e95c2c781ffed690c';
const hits: string[] = [];
let mod: typeof import('@/lib/pool-share');
let readBetLog: typeof import('@/lib/pnl-card-server').readBetLog;

beforeAll(async () => {
  vi.stubEnv('MONAD_RPC_URL', 'https://own-node.invalid/rpc');
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    hits.push(String(url instanceof Request ? url.url : url));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } }), { status: 429 });
  });
  mod = await import('@/lib/pool-share');
  ({ readBetLog } = await import('@/lib/pnl-card-server'));
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('card chain calls under a 429: one request each, no retries', () => {
  it('a bet receipt (public node): one request, and the card reads it as unavailable', async () => {
    hits.length = 0;
    expect(await readBetLog(173n, TX, 5)).toBe('unavailable');
    expect(hits).toEqual(['https://testnet-rpc.monad.xyz/']);
  });

  it('a pool read and a block read (the server\'s node): one request each', async () => {
    hits.length = 0;
    expect(await mod.readPoolForShare(173n)).toBeNull();
    await expect(mod.shareClient().getBlock({ blockNumber: 1n })).rejects.toThrow();
    expect(hits).toEqual(['https://own-node.invalid/rpc', 'https://own-node.invalid/rpc']);
  });

  it('a 500 is not retried either', async () => {
    hits.length = 0;
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      hits.push(String(url));
      return new Response('upstream down', { status: 500 });
    });
    expect(await readBetLog(173n, TX, 5)).toBe('unavailable');
    expect(hits).toHaveLength(1);
  });
});
