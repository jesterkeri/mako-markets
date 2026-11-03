// Adversary pass on fix/card-unfurl 87fc470. Spec (owner + Codex review, binding), rule 1: "the public node is the only
// authority for which bet that is ... The bet ledger (mako_market_events, filled from the other node) and the other
// node never decide which bet it is", and rule 2: "Result cards' kept final facts must never hold a bet other than the
// link's."
//
// 87fc470 changes WHO decides the bet, but not the data cache key the decision is kept under. finalFacts is still
// unstable_cache(<same callback>, ['pnl-card-final-v1', chain, contract], { revalidate: false }), and Next keys an
// unstable_cache entry on `${cb.toString()}-${keyParts.join(',')}-${JSON.stringify(args)}`
// (node_modules/next/dist/server/web/spec-extension/unstable-cache.js lines 55 and 82), an entry that persists "across
// requests and deployments" (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_cache.md line
// 30). The callback's text is unchanged since e2b4fd5, and the minified text is byte-identical in three local
// production builds of different commits (.claude/worktrees/{agent-a4de6fbd138ef6e00,agent-a6a9b8f9ff4bdeba7,
// referrals-open}/.next/server/chunks/[root-of-the-server]__12wwtvf._.js: `async(t,e,r)=>{let n=await tC(BigInt(t),e,r,
// "result");...},["pnl-card-final-v1`). So every result card production kept under e2b4fd5's rule (the ledger row, else
// the own node's receipt) is served by 87fc470 as final, with no chain call, forever.
//
// Scenario: the one the branch's own adversary-card-unfurl-11c8c46.test.ts models (tx 0x29e9…690c, block 74458731,
// public node numbering block-wide; provenance there). One bundle holds two bets on pool 173: A (YES 1 USDC) at public
// log 6, B (NO 7 USDC) at public log 10; the own node numbers them 2 and 6, and the ledger, filled from the own node,
// holds B at (tx, 6). The link for A's result card is /pools/173/pnl/<tx>/6/result. Receipts are built with the repo's
// ABI and viem encoders. The deployment before the fix is the verbatim e2b4fd5 module (fixtures/pnl-card-server-e2b4fd5.ts).

import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const TX = '0x29e9f9a7853b200e127c3d3514549231c2bdd75596b7b82e95c2c781ffed690c' as Hex;
const A = '0x67d68eb043f5bcf0898719ad9a886090148032a0';
const B = '0x00000000000000000000000000000000000000b2';

const bet = (logIndex: number, user: string, isYes: boolean, amount: bigint) => ({
  address: MAKO_ADDRESS.toLowerCase(),
  logIndex,
  topics: encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: 173n, user: user as Hex } }),
  data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [isYes, amount]),
});
const OWN = [bet(2, A, true, U), bet(6, B, false, 7n * U)];
const PUB = [bet(6, A, true, U), bet(10, B, false, 7n * U)];

const SETTLED: MarketWithId = {
  id: 173n,
  creator: A,
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a3130303030300000000000000000000000000000000000000000'.slice(0, 66) as Hex,
  question: 'Will BTC trade above 100000?',
  createdAt: 1792134704n,
  closeTime: 1792135062n,
  bettingCloseTime: 1792134882n,
  totalYes: U,
  totalNo: 7n * U,
  yesBettorCount: 1,
  noBettorCount: 1,
  outcome: Outcome.YES,
  resolved: true,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

// The ledger row the indexer wrote from the own node: B's bet at the own node's index 6.
const ROW = { marketId: '173', actor: B, isYes: false, amount: (7n * U).toString(), block: 74458731, at: new Date(1792134750_000) };

const budget = vi.hoisted(() => new Map<string, number>());
vi.mock('@/lib/envio-budget', () => ({
  upstashCommand: async (args: (string | number)[]) => {
    const [, , , key, , cap] = args as [string, string, number, string, number, number];
    const n = (budget.get(key) ?? 0) + 1;
    budget.set(key, n);
    return n > Number(cap) ? -1 : n;
  },
}));
// Next's data cache, keyed the way Next 16 keys unstable_cache (callback text, key parts, arguments), stored as JSON,
// shared by both deployments as the persistent data cache is.
const dataCache = vi.hoisted(() => new Map<string, string>());
vi.mock('next/cache', () => ({
  unstable_cache:
    (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[]) =>
    async (...args: unknown[]) => {
      const k = `${fn.toString()}-${keyParts.join(',')}-${JSON.stringify(args)}`;
      if (dataCache.has(k)) return JSON.parse(dataCache.get(k)!);
      const r = await fn(...args);
      dataCache.set(k, JSON.stringify(r));
      return r;
    },
}));
const chain = vi.hoisted(() => ({ publicReceipts: 0, ownReceipts: 0 }));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => SETTLED,
  shareClient: () => ({
    getTransactionReceipt: async () => (chain.ownReceipts++, { status: 'success', blockNumber: 74458731n, logs: OWN }),
    getBlock: async () => ({ timestamp: 1792134750n }),
  }),
  publicShareClient: () => ({
    getTransactionReceipt: async () => (chain.publicReceipts++, { status: 'success', blockNumber: 74458731n, logs: PUB }),
  }),
}));
vi.mock('@/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [ROW] }) }) }) } }));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => true }));
vi.mock('@/lib/leaderboard/identity', () => ({ resolveStoredIdentities: async (_db: unknown, addrs: string[]) => new Map(addrs.map((a) => [a, { displayName: null, avatarUrl: null }])) }));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));

beforeEach(() => {
  budget.clear();
  dataCache.clear();
  Object.assign(chain, { publicReceipts: 0, ownReceipts: 0 });
});

describe('rule 2: kept final facts written under the old trust rule are not served as the link\'s bet', () => {
  it('control: on an empty data cache, 87fc470 shows A\'s bet at A\'s link', async () => {
    const { loadCard } = await import('@/lib/pnl-card-server');
    const c = await loadCard('173', TX, '6', 'result', '203.0.113.1');
    expect(c.ok && c.bettor.address).toBe(A);
  });

  it('A\'s result card kept by the e2b4fd5 deployment (from the ledger: B) is still B\'s after 87fc470 deploys', async () => {
    // Before the fix (production e2b4fd5): the ledger row decides, and the result's facts are kept.
    const before = await import('./fixtures/pnl-card-server-e2b4fd5');
    const old = await before.loadCard('173', TX, '6', 'result', '203.0.113.2');
    expect(old.ok && old.bettor.address).toBe(B);
    expect(dataCache.size).toBe(1);

    // 87fc470 deploys over the same data cache. The public node says log 6 is A's bet.
    const after = await import('@/lib/pnl-card-server');
    const c = await after.loadCard('173', TX, '6', 'result', '203.0.113.3');
    expect({ bettor: c.ok && c.bettor.address, publicReceipts: chain.publicReceipts }).toEqual({ bettor: A, publicReceipts: 1 });
  });
});
