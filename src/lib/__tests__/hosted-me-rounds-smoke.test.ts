// Hosted smoke check for rounds in Me (Codex ME_ROUNDS R4's release gate). Skipped unless ME_ROUNDS_SMOKE_URL names a
// hosted Envio GraphQL endpoint built with RoundsSource; it then runs the real /api/me/rounds route against it (real
// network, no fakes), checks every GraphQL response it received, reads the chain the way use-me-rounds.ts does, and
// computes Me's claim amounts with the same pure functions. Read-only: it sends no transaction.
//
//   ME_ROUNDS_SMOKE_URL=https://indexer.dev.hyperindex.xyz/<id>/v1/graphql \
//   ME_ROUNDS_SMOKE_WRONG_URL=<an endpoint that is not this deployment> \
//   ME_ROUNDS_SMOKE_WINNER=0x… ME_ROUNDS_SMOKE_HOST=0x… ME_ROUNDS_SMOKE_ROUND=4 \
//   corepack pnpm@10.32.1 exec vitest run src/lib/__tests__/hosted-me-rounds-smoke.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, http, type Address } from 'viem';

import { monadTestnet } from '@/lib/chain';
import { headMatchesChain, parseMeRoundsDiscovery, planMeRoundReads } from '@/lib/me-rounds-discovery';
import { meRoundPositions, meRoundTotals, type RoundStakeRead } from '@/lib/me-rounds';
import { roundsAbi } from '@/lib/rounds-abi';
import { ROUNDS_RELEASE_RECORD } from '@/lib/rounds-release-record';
import { toRound, type RoundTuple } from '@/lib/use-rounds';

const URL_ = process.env.ME_ROUNDS_SMOKE_URL;
const WRONG = process.env.ME_ROUNDS_SMOKE_WRONG_URL;
const WINNER = process.env.ME_ROUNDS_SMOKE_WINNER as Address | undefined;
const HOST = process.env.ME_ROUNDS_SMOKE_HOST as Address | undefined;
const ROUND = BigInt(process.env.ME_ROUNDS_SMOKE_ROUND ?? '0');
const RPC = 'https://testnet-rpc.monad.xyz';

const rounds = { address: ROUNDS_RELEASE_RECORD!.address, abi: roundsAbi } as const;
const client = createPublicClient({ chain: monadTestnet, transport: http(RPC) });

/// Every GraphQL answer the route received in one call, as JSON.
const seen: { query: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;

async function route(url: string, account: string) {
  vi.resetModules();
  process.env.ENVIO_ROUNDS_GRAPHQL_URL = url;
  seen.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const res = await realFetch(input, init);
    const q = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    seen.push({ query: /query (\w+)/.exec(q.query ?? '')?.[1] ?? '?', body: (await res.clone().json()) as Record<string, unknown> });
    return res;
  });
  const { GET } = await import('@/app/api/me/rounds/route');
  const res = await GET(new Request(`http://localhost/api/me/rounds?account=${account}`));
  vi.restoreAllMocks();
  return { status: res.status, body: (await res.json()) as unknown, pages: [...seen] };
}

/// Me's view of `account`, read on chain exactly as use-me-rounds.ts reads it.
async function meView(account: Address, discoveryBody: unknown) {
  const count = (await client.readContract({ ...rounds, functionName: 'roundCount' })) as bigint;
  const d = parseMeRoundsDiscovery(discoveryBody);
  expect(d, 'discovery parses').not.toBeNull();
  const plan = planMeRoundReads(count, d!);
  expect(plan.ok, 'plan is bounded').toBe(true);
  const ids = plan.ok ? plan.ids : [];
  const rs = [];
  const stakes = new Map<string, RoundStakeRead>();
  let bound = d!.head === null;
  for (const id of ids) {
    const t = (await client.readContract({ ...rounds, functionName: 'roundOf', args: [id] })) as RoundTuple;
    const s = (await client.readContract({ ...rounds, functionName: 'stakeOf', args: [id, account] })) as { side: number; amount: bigint };
    const claimed = (await client.readContract({ ...rounds, functionName: 'stakeClaimed', args: [id, account] })) as boolean;
    const feeClaimed = (await client.readContract({ ...rounds, functionName: 'creatorFeeClaimed', args: [id] })) as boolean;
    if (d!.head && id === d!.head.id) bound = headMatchesChain(d!.head, t);
    rs.push(toRound(id, t));
    const side = Number(s.side) === 1 ? 'up' : Number(s.side) === 2 ? 'down' : null;
    stakes.set(id.toString(), { stake: { side, amount: BigInt(s.amount) }, claimed, creatorFeeClaimed: feeClaimed });
  }
  const positions = meRoundPositions(rs, stakes, account, Math.floor(Date.now() / 1000));
  return { count, ids, bound, totals: meRoundTotals(positions) };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENVIO_ROUNDS_GRAPHQL_URL;
});

describe.skipIf(!URL_ || !WINNER || !HOST || ROUND === 0n)('hosted Envio smoke for rounds in Me', () => {
  for (const [who, account] of [
    ['old winning entry', WINNER!],
    ['fee-only host', HOST!],
  ] as const) {
    it(`${who}: every page carries the reviewed source, round ${ROUND} is found, and Me's claim matches chain`, async () => {
      const r = await route(URL_!, account);
      console.log(`[smoke] ${who} ${account}: status ${r.status}, body ${JSON.stringify(r.body)}`);
      for (const p of r.pages) console.log(`[smoke]   ${p.query}: RoundsSource ${JSON.stringify(p.body.data && (p.body.data as Record<string, unknown>).RoundsSource)}`);
      expect(r.status).toBe(200);
      // Items 1 and 2: each exact query was accepted (no GraphQL errors) and returned exactly the reviewed source row.
      expect(new Set(r.pages.map((p) => p.query))).toEqual(new Set(['MeRoundsHead', 'MeRoundsHeadRound', 'MeRoundsActive', 'MeRoundsEntries', 'MeRoundsCreated']));
      for (const p of r.pages) {
        expect(p.body.errors, `${p.query} errors`).toBeUndefined();
        expect((p.body.data as Record<string, unknown>).RoundsSource).toEqual([{ sourceChain: 10143, address: ROUNDS_RELEASE_RECORD!.address.toLowerCase() }]);
      }
      expect((r.body as { roundIds: string[] }).roundIds).toContain(ROUND.toString());
      // Item 3: Me's view, from chain, bound to this contract, with the round's claim.
      const v = await meView(account, r.body);
      console.log(`[smoke]   chain roundCount ${v.count}; reads ${v.ids.length} rounds; bound ${v.bound}; claims ${v.totals.claims.map((c) => `#${c.round.id}=${c.claim}`).join(', ')}`);
      expect(v.bound).toBe(true);
      const c = v.totals.claims.find((x) => x.round.id === ROUND);
      expect(c, `round ${ROUND} claimable in Me`).toBeDefined();
      // The amount claim(roundId) would pay, checked independently: simulate it from this account (read-only eth_call).
      const sim = await client.simulateContract({ ...rounds, functionName: 'claim', args: [ROUND], account });
      console.log(`[smoke]   claim(${ROUND}) simulated from ${account}: ok (${String(sim.result)})`);
    }, 120_000);
  }

  it.skipIf(!WRONG)('item 4: Me pointed at another endpoint is unavailable, never a list', async () => {
    const r = await route(WRONG!, WINNER!);
    console.log(`[smoke] wrong endpoint: status ${r.status}, body ${JSON.stringify(r.body)}`);
    expect(r.status).toBe(502);
    expect(r.body).not.toHaveProperty('roundIds');
  }, 60_000);
});
