// Adversary pass on fix/card-unfurl (15271be over e2b4fd5): readBetLog asks the public Monad node when the server's own
// node (MONAD_RPC_URL) does not find the bet. Spec (owner, binding):
//  2. a bundler bet's card works on production, where the server's own node did not return the bet and the public
//     node did;
//  3. "a transient chain failure or a not-yet-seen receipt is never cached publicly as 'not a card'".
//
// Fixture provenance, read from the public Monad testnet RPC (https://testnet-rpc.monad.xyz/) on 2026-10-26 against
// the live V4 contract 0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195:
//  - tx 0x29e9f9a7…690c (EntryPoint 0x0000000071727De22E5E9d8BAf0edAc6f37da032, gas-free bundler), block 74458731,
//    timestamp 1793041248, status success; log 5 = BetPlaced(173, 0x67D6…32A0, true, 1000000). The block's only
//    earlier log is index 0, emitted by the system address 0x…1000 in transaction 0 of the block.
//  - pool #173 at latest and finalized: CRYPTO, "Will ETH be below $2,290 at 20:03 UTC on Mon 26 Oct?", totals
//    1000000 / 0, unresolved.
// The log is re-encoded with the repo's own ABI (viem encoders) at MAKO_ADDRESS. The own node's receipt is the same
// receipt without the bet at index 5 (here: numbered from 0 within the block, as a node that leaves out the system
// transaction's log would number it), which is the production state spec 2 describes. The Upstash store is the
// in-memory stand-in pnl-card-abuse.test.ts and adversary-share-card-r3.test.ts use.

import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/pools/[id]/pnl/[tx]/[log]/[state]/image.png/route';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const TX = '0x29e9f9a7853b200e127c3d3514549231c2bdd75596b7b82e95c2c781ffed690c' as Hex;
const BETTOR = '0x67D68Eb043f5bCf0898719Ad9a886090148032A0';
const POOL_173: MarketWithId = {
  id: 173n,
  creator: BETTOR,
  mType: MarketType.CRYPTO,
  oracleRef: '0x4554483a6c743a32323930000000000000000000000000000000000000000000',
  question: 'Will ETH be below $2,290 at 20:03 UTC on Mon 26 Oct?',
  createdAt: 1793041248n,
  closeTime: 1793044980n,
  bettingCloseTime: 1793043484n,
  totalYes: U,
  totalNo: 0n,
  yesBettorCount: 1,
  noBettorCount: 0,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

const store = vi.hoisted(() => ({ now: 0, keys: new Map<string, { n: number; until: number }>() }));
vi.mock('@/lib/envio-budget', () => ({
  upstashCommand: async (args: (string | number)[]) => {
    const [, , , key, windowMs, cap] = args as [string, string, number, string, number, number];
    const cur = store.keys.get(key);
    const slot = cur && cur.until > store.now ? cur : { n: 0, until: store.now + Number(windowMs) };
    slot.n++;
    store.keys.set(key, slot);
    return slot.n > Number(cap) ? -1 : slot.n;
  },
}));

const betLog = (logIndex: number) => ({
  address: MAKO_ADDRESS.toLowerCase(),
  logIndex,
  topics: encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: 173n, user: BETTOR } }),
  data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, U]),
});
const receipt = (logIndex: number) => ({ status: 'success', blockNumber: 74458731n, logs: [betLog(logIndex)] });

// pubFailures: how many public-node receipt reads fail with a transient error (the public node's ~15 requests a
// second limit answers 429) before it answers.
const nodes = vi.hoisted(() => ({ pubFailures: 0 }));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => POOL_173,
  // The server's own node: it has the receipt, but not the bet at index 5.
  shareClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash !== TX) throw new TransactionReceiptNotFoundError({ hash });
      return receipt(4);
    },
    getBlock: async () => ({ timestamp: 1793041248n }),
  }),
  // The public node: the bet at index 5, where the browser found it.
  publicShareClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (nodes.pubFailures-- > 0) throw new Error('HTTP request failed. Status: 429');
      if (hash !== TX) throw new TransactionReceiptNotFoundError({ hash });
      return receipt(5);
    },
  }),
}));
vi.mock('@/db/client', () => ({ db: {} }));
// Not in the bet ledger yet (the select chain throws, which ledgerBet reads as "not there").
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => true }));
vi.mock('@/lib/leaderboard/identity', () => ({
  resolveStoredIdentities: async (_db: unknown, addrs: string[]) => new Map(addrs.map((a) => [a, { displayName: 'jester', avatarUrl: null, branch: 'magic' }])),
}));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));
vi.mock('@/lib/pool-qr', () => ({ poolQr: async () => 'data:image/svg+xml;base64,' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-real-ip': '203.0.113.9' }) }));
vi.mock('@/lib/pnl-card-image', () => ({
  CARD_SIZE: { width: 1600, height: 900 },
  renderShareCard: async (_card: unknown, _who: unknown, _qr: unknown, headers: Record<string, string>) => new Response('png', { headers }),
}));

const isPublic = (r: Response) => /\bpublic\b|s-maxage|max-age=[1-9]/.test(r.headers.get('cache-control') ?? '');

const image = () =>
  GET(new Request(`http://localhost/pools/173/pnl/${TX}/5/placed/image.png`, { headers: { 'x-real-ip': '203.0.113.9' } }), {
    params: Promise.resolve({ id: '173', tx: TX, log: '5', state: 'placed' }),
  });

beforeEach(() => {
  store.now = 0;
  store.keys.clear();
  nodes.pubFailures = 0;
});

describe('spec 3: a transient failure of the public node is never cached publicly as "not a card"', () => {
  it('control: the bundler bet of pool 173 is a card when the public node answers', async () => {
    const res = await image();
    expect(res.status).toBe(200);
  });

  // Only the public node can find this bet (spec 2), so when it cannot be asked, nothing is known about the card. The
  // own node's "no bet at 5" is returned as final (null -> not_found), which the image route caches publicly for a
  // minute: X's or WhatsApp's crawler, fetching once, gets the cached 404 for a real card.
  it('the public node answers 429 once: the image is not a publicly cached 404', async () => {
    nodes.pubFailures = 1;
    const first = await image();
    store.now += 5_000;
    const second = await image();
    expect(second.status).toBe(200); // the same URL is a card a moment later
    const verdict = first.status === 404 && isPublic(first) ? `404 cached publicly (${first.headers.get('cache-control')})` : 'not a publicly cached 404';
    expect(verdict).toBe('not a publicly cached 404');
  });
});
