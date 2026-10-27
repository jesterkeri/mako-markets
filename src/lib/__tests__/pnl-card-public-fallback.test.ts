// A shared card's bet comes from the public Monad node whenever the server names another one (Codex CARD_UNFURL R1
// F1): the browser took the link's log index from the public node, and another node may number a transaction's logs
// differently, so its bet at that index could be another bet. It is also where production's own node missed a bet sent
// through the gas-free bundler (pool 173, log 5, Joshua 2026-10-26). Same checks either way: the live contract's
// BetPlaced for this pool at exactly that log index, in a successful receipt.

import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKO_ADDRESS, makoAbi } from '../contract';

const U = 1_000_000n;
const TX = '0x29e9f9a7853b200e127c3d3514549231c2bdd75596b7b82e95c2c781ffed690c' as Hex;
const USER = '0x67d68eb043f5bcf0898719ad9a886090148032a0';

type Answer = 'missing' | 'error' | { status?: 'success' | 'reverted'; logs: object[] };
const nodes = vi.hoisted(() => ({ own: 'missing' as unknown, pub: 'missing' as unknown, pubOn: true, ownCalls: 0, pubCalls: 0 }));

const client = (which: 'own' | 'pub') => ({
  getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
    if (which === 'pub') nodes.pubCalls += 1;
    else nodes.ownCalls += 1;
    const a = nodes[which] as Answer;
    if (a === 'missing') throw new TransactionReceiptNotFoundError({ hash });
    if (a === 'error') throw new Error('429 monthly capacity exceeded');
    return { status: a.status ?? 'success', blockNumber: 74458731n, logs: a.logs };
  },
});
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => null,
  shareClient: () => client('own'),
  publicShareClient: () => (nodes.pubOn ? client('pub') : null),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

import { readBetLog } from '@/lib/pnl-card-server';

const bet = (logIndex: number, o: { id?: bigint; address?: string; event?: 'BetPlaced' | 'Claimed' } = {}) => ({
  address: (o.address ?? MAKO_ADDRESS).toLowerCase(),
  logIndex,
  topics:
    o.event === 'Claimed'
      ? encodeEventTopics({ abi: makoAbi, eventName: 'Claimed', args: { id: o.id ?? 173n, user: USER } })
      : encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: o.id ?? 173n, user: USER } }),
  data: o.event === 'Claimed' ? encodeAbiParameters([{ type: 'uint256' }], [U]) : encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, U]),
});
const FOUND = { address: USER, isYes: true, amount: U, block: 74458731n };

beforeEach(() => {
  nodes.own = 'missing';
  nodes.pub = 'missing';
  nodes.pubOn = true;
  nodes.ownCalls = 0;
  nodes.pubCalls = 0;
});

describe('readBetLog: the public node decides when the server names another node', () => {
  it('the own node has no receipt, the public node has the bet: the bet, and the own node is never asked', async () => {
    nodes.pub = { logs: [bet(5)] };
    expect(await readBetLog(173n, TX, 5)).toEqual(FOUND);
    expect(nodes.ownCalls).toBe(0);
  });

  it('the own node has a bet at that index, the public node has none: no card (the public numbering is the link\'s)', async () => {
    nodes.own = { logs: [bet(5)] };
    nodes.pub = { logs: [bet(4)] };
    expect(await readBetLog(173n, TX, 5)).toBeNull();
    expect(nodes.ownCalls).toBe(0);
  });

  it('the public node cannot answer: unavailable, even when the own node has the bet', async () => {
    nodes.own = { logs: [bet(5)] };
    nodes.pub = 'error';
    expect(await readBetLog(173n, TX, 5)).toBe('unavailable');
  });

  it('the public node has no receipt yet: no_receipt (not yet), whatever the own node has', async () => {
    nodes.own = { logs: [bet(5)] };
    expect(await readBetLog(173n, TX, 5)).toBe('no_receipt');
  });

  it('the public node gets every check: another pool, another contract, another event, another index, a reverted receipt', async () => {
    for (const pub of [
      { logs: [bet(5, { id: 172n })] },
      { logs: [bet(5, { address: '0x0000000000000000000000000000000000000002' })] },
      { logs: [bet(5, { event: 'Claimed' })] },
      { logs: [bet(6)] },
      { status: 'reverted' as const, logs: [bet(5)] },
    ]) {
      nodes.pub = pub;
      expect(await readBetLog(173n, TX, 5)).toBeNull();
    }
  });

  it('no separate public node (the server already uses it): the server\'s node, one read', async () => {
    nodes.pubOn = false;
    nodes.own = { logs: [bet(5)] };
    expect(await readBetLog(173n, TX, 5)).toEqual(FOUND);
    expect([nodes.ownCalls, nodes.pubCalls]).toEqual([1, 0]);
  });
});
