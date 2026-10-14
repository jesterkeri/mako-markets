// Adversary on 2c716f6 (Codex DS_SWAP R4 fix): the verification block is agreed by both providers and fresh.
// Driven by the real BTC/USD report in test/fixtures (observed 2026-09-16 03:26:00 UTC, expiresAt 1792121160, i.e.
// 30 days later; see btcusd-1789529160-verified.json). Block headers are stubs of a consistent chain: every block both
// providers return is the same real-looking block (same number, hash and timestamp on both), so only the choice of
// WHICH finalized block is under a single provider's control.
import { decodeAbiParameters, encodeFunctionResult, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import fixture from './fixtures/fixture-btcusd-1789529160.json';
import verifiedEvidence from './fixtures/btcusd-1789529160-verified.json';
import { agreedFinalized, dataStreamsCryptoDecision, type DsDeps } from '../src/crypto-datastreams';
import type { RpcCall } from '../src/datastreams';

const CLOSE = Number(fixture.observationsTimestamp);
const EXPIRES = Number(verifiedEvidence.expiresAt);
const payload = decodeAbiParameters(
  [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }],
  fixture.fullReport as Hex,
)[1].toLowerCase() as Hex;
const verifierAbi = [
  { type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'payload', type: 'bytes' }, { name: 'parameterPayload', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;
const verifyReturn = encodeFunctionResult({ abi: verifierAbi, functionName: 'verify', result: payload }).toLowerCase() as Hex;
const ZERO = `0x${'0'.repeat(64)}` as Hex;
const verifier = (): RpcCall => async (_to, data) => (data.length <= 10 ? { ok: true, result: ZERO } : { ok: true, result: verifyReturn });

/// One chain, 1 block per second, block n has timestamp BASE_TS + n. Both providers serve the same headers; each names
/// its own `finalized` head.
const BASE_TS = EXPIRES - 1000;
const header = (n: bigint) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(BASE_TS + Number(n)).toString(16)}`, hash: `0x${n.toString(16).padStart(64, '0')}` });
const rpc = (heads: Record<string, bigint>) =>
  (async (url: string, init?: RequestInit) => {
    const tag = JSON.parse(String(init?.body)).params[0] as string;
    const n = tag === 'finalized' ? heads[url] : BigInt(tag);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: header(n) }));
  }) as unknown as typeof fetch;
const blockAt = (ts: number) => BigInt(ts - BASE_TS);

function deps(nowMs: number, heads: Record<string, bigint>): DsDeps {
  const body = JSON.stringify({ report: { feedID: fixture.feedID, observationsTimestamp: CLOSE, fullReport: fixture.fullReport } });
  return {
    fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    base: 'https://api.testnet-dataengine.chain.link',
    creds: { apiKey: 'test-key-id', secret: 'test-secret-value' },
    providers: [verifier(), verifier()],
    finalized: () => agreedFinalized(rpc(heads), ['A', 'B'], nowMs),
    verifiedBy: ['monad-testnet.g.alchemy.com', 'rpc.ankr.com'],
    now: () => nowMs,
  };
}
const pool = { mType: 1, oracleRef: stringToHex('BTC:gt:75000', { size: 32 }), closeTime: CLOSE };

describe('spec 4: neither provider alone can settle a report expired at the real current time', () => {
  it('control: both providers honest (finalized 1 s behind), report expired 30 s ago, waits', async () => {
    const now = EXPIRES + 30;
    const d = await dataStreamsCryptoDecision(pool, deps(now * 1000, { A: blockAt(now - 1), B: blockAt(now - 1) }));
    expect(d).toMatchObject({ kind: 'wait', reason: 'report_expired' });
  });
  it('one provider names a real block 50 s old as finalized, report expired 30 s ago: must wait', async () => {
    const now = EXPIRES + 30;
    // A (honest) finalized at now-1; B names an older real block (now-50) that A agrees on, since it is real.
    const d = await dataStreamsCryptoDecision(pool, deps(now * 1000, { A: blockAt(now - 1), B: blockAt(now - 50) }));
    expect(d.kind).toBe('wait');
  });
});

describe('spec 2: a block older than 60 s means wait', () => {
  it('a block 60.999 s old on the worker clock is refused', async () => {
    const nowS = EXPIRES - 500;
    const ts = nowS - 60;
    const nowMs = nowS * 1000 + 999; // the block is 60.999 s old
    const r = await agreedFinalized(rpc({ A: blockAt(ts), B: blockAt(ts) }), ['A', 'B'], nowMs);
    expect(r).toEqual({ ok: false, reason: 'block_stale' });
  });
});

describe('attacks the fix holds against (these pass)', () => {
  const NOW = EXPIRES - 500;
  type H = { number: string; timestamp: string; hash: string } | null;
  const custom = (fa: (tag: string) => H, fb: (tag: string) => H) =>
    (async (url: string, init?: RequestInit) => {
      const tag = JSON.parse(String(init?.body)).params[0] as string;
      return new Response(JSON.stringify({ result: (url === 'A' ? fa : fb)(tag) }));
    }) as unknown as typeof fetch;
  const honest = (head: bigint) => (tag: string) => header(tag === 'finalized' ? head : BigInt(tag));
  it('one provider lies about the timestamp of the agreed number', async () => {
    const liar = (tag: string) => ({ ...honest(blockAt(NOW - 1))(tag), timestamp: `0x${(NOW + 5).toString(16)}` });
    expect(await agreedFinalized(custom(honest(blockAt(NOW - 1)), liar), ['A', 'B'], NOW * 1000)).toEqual({ ok: false, reason: 'block_disagree' });
  });
  it('hash case and leading zeros / uppercase hex agree', async () => {
    const shout = (tag: string) => {
      const h = honest(blockAt(NOW - 1))(tag);
      return { number: `0x000${h.number.slice(2).toUpperCase()}`, timestamp: `0x00${h.timestamp.slice(2).toUpperCase()}`, hash: `0x${h.hash.slice(2).toUpperCase()}` };
    };
    expect(await agreedFinalized(custom(honest(blockAt(NOW - 1)), shout), ['A', 'B'], NOW * 1000)).toMatchObject({ ok: true });
  });
  it('a provider ahead by 2^200 blocks: the lower one is asked of both', async () => {
    const far = (tag: string) => (tag === 'finalized' ? header(2n ** 200n) : honest(0n)(tag));
    expect(await agreedFinalized(custom(honest(blockAt(NOW - 1)), far), ['A', 'B'], NOW * 1000)).toEqual({ ok: true, block: { number: blockAt(NOW - 1), timestamp: NOW - 1 } });
  });
  it('a provider answers a number with a different block number', async () => {
    const shift = (tag: string) => (tag === 'finalized' ? header(blockAt(NOW - 1)) : header(BigInt(tag) + 1n));
    expect(await agreedFinalized(custom(honest(blockAt(NOW - 2)), shift), ['A', 'B'], NOW * 1000)).toEqual({ ok: false, reason: 'block_disagree' });
  });
  it('a huge timestamp (beyond 2^53) on both is stale, not settled', async () => {
    const huge = (tag: string) => ({ ...honest(blockAt(NOW - 1))(tag), timestamp: '0xffffffffffffffffffff' });
    expect(await agreedFinalized(custom(huge, huge), ['A', 'B'], NOW * 1000)).toEqual({ ok: false, reason: 'block_stale' });
  });
  it('exactly 60 s old passes, 61 s old waits; 10 s ahead passes, 11 s waits', async () => {
    const at = (ts: number) => agreedFinalized(rpc({ A: blockAt(ts), B: blockAt(ts) }), ['A', 'B'], NOW * 1000);
    expect((await at(NOW - 60)).ok).toBe(true);
    expect(await at(NOW - 61)).toEqual({ ok: false, reason: 'block_stale' });
    expect((await at(NOW + 10)).ok).toBe(true);
    expect(await at(NOW + 11)).toEqual({ ok: false, reason: 'block_stale' });
  });
  it('a provider that throws or times out waits', async () => {
    const f = (async (url: string, init?: RequestInit) =>
      url === 'B' ? Promise.reject(new DOMException('t', 'TimeoutError')) : rpc({ A: blockAt(NOW - 1) })(url, init)) as unknown as typeof fetch;
    expect(await agreedFinalized(f, ['A', 'B'], NOW * 1000)).toEqual({ ok: false, reason: 'block_unavailable' });
  });
});
