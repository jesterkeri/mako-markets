// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/event-decode.test.ts
//
// Coverage for event-decode.ts: feed synthetic logs through the
// discriminated-union decoder, verify each branch's args shape and
// that unrelated logs are filtered out. Uses viem's encodeEventTopics
// + encodeAbiParameters to construct realistic logs without spinning
// up an actual chain.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  encodeEventTopics,
  encodeAbiParameters,
  parseAbiParameters,
  type Log,
} from 'viem';
import { privateMarketsAbi } from '@/lib/MakoPrivateMarketsV1.abi';
import { decodePrivateMarketsLogs } from '../event-decode';

const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;

function buildMarketCreatedLog(args: {
  marketId: bigint;
  creator: `0x${string}`;
  marketShape: number;
  createdAt: bigint;
  stakingOpensAt: bigint;
  closeAt: bigint;
  visibilityView: number;
  visibilityParticipation: number;
  clientNonce: `0x${string}`;
}): Log {
  // Indexed args: marketId, creator. Non-indexed: everything else.
  const topics = encodeEventTopics({
    abi: privateMarketsAbi,
    eventName: 'MarketCreated',
    args: { marketId: args.marketId, creator: args.creator },
  });
  // Non-indexed parameters in order from the ABI:
  // marketShape (uint8), createdAt (uint256), stakingOpensAt (uint256),
  // closeAt (uint256), visibilityView (uint8), visibilityParticipation (uint8),
  // clientNonce (bytes32).
  const data = encodeAbiParameters(
    parseAbiParameters(
      'uint8, uint256, uint256, uint256, uint8, uint8, bytes32',
    ),
    [
      args.marketShape,
      args.createdAt,
      args.stakingOpensAt,
      args.closeAt,
      args.visibilityView,
      args.visibilityParticipation,
      args.clientNonce,
    ],
  );
  return {
    address: CONTRACT,
    topics: topics as unknown as Log['topics'],
    data,
    blockNumber: 30700000n,
    transactionHash:
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    transactionIndex: 0,
    logIndex: 0,
    blockHash:
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    removed: false,
  } as Log;
}

function buildMarketMetadataFrozenLog(marketId: bigint, frozenAt: bigint): Log {
  const topics = encodeEventTopics({
    abi: privateMarketsAbi,
    eventName: 'MarketMetadataFrozen',
    args: { marketId },
  });
  const data = encodeAbiParameters(parseAbiParameters('uint256'), [frozenAt]);
  return {
    address: CONTRACT,
    topics: topics as unknown as Log['topics'],
    data,
    blockNumber: 30700001n,
    transactionHash:
      '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    transactionIndex: 0,
    logIndex: 1,
    blockHash:
      '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    removed: false,
  } as Log;
}

describe('decodePrivateMarketsLogs', () => {
  it('decodes a MarketCreated log into the typed branch', () => {
    const log = buildMarketCreatedLog({
      marketId: 42n,
      creator: '0x1111111111111111111111111111111111111111',
      marketShape: 0, // Friendly
      createdAt: 1778544000n,
      stakingOpensAt: 1778544060n,
      closeAt: 1778544600n,
      visibilityView: 0,
      visibilityParticipation: 1,
      clientNonce:
        '0x0000000000000000000000000000000000000000000000000000000000000001',
    });
    const decoded = decodePrivateMarketsLogs([log]);
    expect(decoded).toHaveLength(1);
    const e = decoded[0];
    expect(e.eventName).toBe('MarketCreated');
    if (e.eventName !== 'MarketCreated') return;
    expect(e.args.marketId).toBe(42n);
    expect(e.args.creator.toLowerCase()).toBe(
      '0x1111111111111111111111111111111111111111',
    );
    expect(e.args.marketShape).toBe(0);
    expect(e.args.stakingOpensAt).toBe(1778544060n);
    expect(e.args.clientNonce).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    );
  });

  it('decodes a MarketMetadataFrozen log', () => {
    const log = buildMarketMetadataFrozenLog(7n, 1778544999n);
    const decoded = decodePrivateMarketsLogs([log]);
    expect(decoded).toHaveLength(1);
    const e = decoded[0];
    expect(e.eventName).toBe('MarketMetadataFrozen');
    if (e.eventName !== 'MarketMetadataFrozen') return;
    expect(e.args.marketId).toBe(7n);
    expect(e.args.frozenAt).toBe(1778544999n);
  });

  it('filters out unrelated logs (foreign topic0)', () => {
    const foreignLog: Log = {
      address: CONTRACT,
      topics: [
        '0x0000000000000000000000000000000000000000000000000000000000000abc',
      ] as unknown as Log['topics'],
      data: '0x',
      blockNumber: 30700002n,
      transactionHash:
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      transactionIndex: 0,
      logIndex: 0,
      blockHash:
        '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      removed: false,
    } as Log;
    const decoded = decodePrivateMarketsLogs([foreignLog]);
    expect(decoded).toHaveLength(0);
  });

  it('decodes a mixed-event batch in input order', () => {
    const created = buildMarketCreatedLog({
      marketId: 1n,
      creator: '0x2222222222222222222222222222222222222222',
      marketShape: 1,
      createdAt: 0n,
      stakingOpensAt: 0n,
      closeAt: 100n,
      visibilityView: 0,
      visibilityParticipation: 0,
      clientNonce:
        '0x0000000000000000000000000000000000000000000000000000000000000002',
    });
    const frozen = buildMarketMetadataFrozenLog(1n, 50n);
    const decoded = decodePrivateMarketsLogs([created, frozen]);
    expect(decoded.map((e) => e.eventName)).toEqual([
      'MarketCreated',
      'MarketMetadataFrozen',
    ]);
  });
});
