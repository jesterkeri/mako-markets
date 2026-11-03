// Adversary pass on fix/card-unfurl 11c8c46 (readBetLog then asked the server's own node first; Codex CARD_UNFURL R1 F1
// required the public node to decide, and this test to be kept). Production evidence later showed the two nodes agree on
// numbering today; the case stays covered because a node may change it (draft EIP-8116). Spec (owner,
// binding), rule 1: "A card shows only the bet its link names: the live contract's BetPlaced for that pool at exactly
// that log index of that transaction ... Never another bet". The link's log index is the public node's (the browser
// found the log there; pool-share.ts publicShareClient and pnl-card-server.ts readBetLog say so).
//
// The two nodes number a transaction's logs differently. Provenance, public Monad testnet RPC
// (https://testnet-rpc.monad.xyz/, eth_getTransactionReceipt, 2026-10-26): tx 0x29e9f9a7…690c is transaction 1 of
// block 74458731 and its logs carry logIndex 1..7 (block-level numbering; index 0 belongs to the block's system
// transaction), BetPlaced(173) at 5. Production's own node returned the receipt but no BetPlaced(173) at 5 (the 404
// recorded in DONE.md 2026-10-26), so its numbering of the same logs differs; the branch's own tests model it as an
// offset ("own node numbers the logs differently").
//
// So when one transaction holds two bets on the same pool (two user operations in one bundle), the own node's log at
// the link's index can be the OTHER bet, and readBetLog returns it without asking the public node. The receipts below
// are constructed with the repo's ABI and viem encoders: a block whose system log is 0 and whose transaction 1 has 3
// logs (1..3); the bundle is transaction 2 with BeforeExecution, then per operation Transfer, BetPlaced,
// ExecutionSuccess, UserOperationEvent. Public (block) numbering: bet A at 6, bet B at 10. Own (per transaction from 0)
// numbering: bet A at 2, bet B at 6. Only the BetPlaced logs are listed; the others never match.

import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { MAKO_ADDRESS, makoAbi } from '../contract';

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

vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => null,
  shareClient: () => ({ getTransactionReceipt: async () => ({ status: 'success', blockNumber: 74458731n, logs: OWN }) }),
  publicShareClient: () => ({ getTransactionReceipt: async () => ({ status: 'success', blockNumber: 74458731n, logs: PUB }) }),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

import { readBetLog } from '@/lib/pnl-card-server';

describe('rule 1: the bet at the link\'s log index, never another bet in the same transaction', () => {
  it('link for bet A (public index 6): the card is A\'s bet, not B\'s, which the own node numbers 6', async () => {
    const got = await readBetLog(173n, TX, 6);
    expect(got).toEqual({ address: A, isYes: true, amount: U, block: 74458731n });
  });
});
