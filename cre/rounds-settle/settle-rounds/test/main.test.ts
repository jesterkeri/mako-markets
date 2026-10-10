// The handler end to end against the CRE SDK's own test runtime and capability mocks (EvmMock,
// HttpActionsMock): which reads it makes and at which block, what it fetches with which headers, what it
// writes where, and how each kind of failure ends the run. No network, no chain.
import { describe, expect } from 'bun:test';
import { EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test, addContractMock } from '@chainlink/cre-sdk/test';
import type { HTTP_CLIENT_PB } from '@chainlink/cre-sdk/pb';
import { bytesToHex, decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem';
import { initWorkflow, onCronTrigger, SECRET_API_KEY, SECRET_API_SECRET } from '../main';
import { decodeSettleReport, FEED_ID, hmacSha256Hex, MULTICALL3, MULTICALL3_ABI, reportPath, ROUNDS_ABI, signingString, type Config } from '../logic';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

type Request = HTTP_CLIENT_PB.Request;

const MONAD_TESTNET_SELECTOR = 2183018362218727504n;
const ROUNDS = '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921';
const ADAPTER = '0x00000000000000000000000000000000000000aa';
const ORIGIN = 'https://api.testnet-dataengine.chain.link';
// Test-only secret values: they exist so the signature can be checked, and are not credentials.
const KEY = 'test-key';
const SECRET = 'test-secret';

const config: Config = {
  schedule: '15 * * * * *',
  chainSelectorName: 'monad-testnet',
  roundsAddress: ROUNDS,
  adapterAddress: ADAPTER,
  dataStreamsUrl: ORIGIN,
  settleDelaySeconds: 10,
  gasLimit: '1500000',
};

// The round closes at the fixture's real observation second; its anchor is DURATION (900 s) earlier.
const CLOSE = BigInt(fixture.observationsTimestamp);
const ANCHOR = Number(CLOSE) - 900;
const CLOSE_REPORT = fixture.fullReport.toLowerCase() as Hex;
// The anchor answer is SYNTHETIC (no real report was captured at ANCHOR); readReport checks only the JSON
// envelope, and the bytes here exist to prove they travel unchanged to the write.
const ANCHOR_REPORT = `0x${'ab'.repeat(64)}` as Hex;
const NOW_MS = (Number(CLOSE) + 60) * 1000;

const secrets = () => new Map([['main', new Map([[SECRET_API_KEY, KEY], [SECRET_API_SECRET, SECRET]])]]);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const answer = (boundary: number, fullReport: Hex) =>
  JSON.stringify({ report: { feedID: FEED_ID, observationsTimestamp: boundary, validFromTimestamp: boundary - 3, fullReport } });

type Setup = {
  pending?: bigint[];
  http?: (req: Request) => { statusCode: number; body: string; headers?: Record<string, string> };
  write?: 'success' | 'receiver-reverted' | 'tx-reverted';
  adapter?: string;
  withSecrets?: boolean;
  failIds?: bigint[];
  simulateRevert?: boolean;
};

function setup(s: Setup = {}) {
  const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR);
  const rounds = addContractMock(evm, { address: ROUNDS, abi: ROUNDS_ABI });
  rounds.pendingSettlement = () => s.pending ?? [];
  rounds.DURATION = () => 900n;
  // settle is not a view, so the typed mock does not list it; the runtime mock routes any ABI function.
  (rounds as unknown as Record<string, () => void>).settle = () => (s.simulateRevert ? (() => { throw new Error('execution reverted'); })() : undefined);
  const closeTimeOf = (id: bigint) => (id === 7n ? CLOSE : CLOSE + 100_000n);
  rounds.closeTimeOf = (id: unknown) => closeTimeOf(id as bigint);
  // Multicall3 answers each inner call the way the deployed contract would; `failIds` revert (unknown round).
  const multicall = addContractMock(evm, { address: MULTICALL3, abi: MULTICALL3_ABI });
  const inner3: { target: string; fn: string }[] = [];
  multicall.aggregate3 = (calls: unknown) =>
    (calls as { target: string; allowFailure: boolean; callData: Hex }[]).map((c) => {
      const d = decodeFunctionData({ abi: ROUNDS_ABI, data: c.callData });
      inner3.push({ target: c.target, fn: d.functionName });
      if (d.functionName === 'DURATION') return { success: true, returnData: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'DURATION', result: 900n }) };
      const id = (d.args as readonly bigint[])[0];
      if (s.failIds?.includes(id)) return { success: false, returnData: '0x' as Hex };
      return { success: true, returnData: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'closeTimeOf', result: closeTimeOf(id) }) };
    });
  const reads: { fn: string; block: string }[] = [];
  const inner = evm.callContract!;
  evm.callContract = (req) => {
    const sel = bytesToHex(req.call!.data).slice(0, 10);
    reads.push({ fn: sel, block: `${req.blockNumber?.sign}:${Array.from(req.blockNumber?.absVal ?? [])}` });
    return inner(req);
  };
  const adapter = addContractMock(evm, { address: ADAPTER, abi: parseAbi(['function onReport(bytes metadata, bytes report)']) });
  const writes: { receiver: Hex; payload: Hex; gasLimit: bigint }[] = [];
  adapter.writeReport = (input) => {
    writes.push({
      receiver: bytesToHex(input.receiver),
      payload: bytesToHex(input.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH)),
      gasLimit: input.gasConfig.gasLimit,
    });
    return {
      txStatus: s.write === 'tx-reverted' ? 'TX_STATUS_REVERTED' : 'TX_STATUS_SUCCESS',
      receiverContractExecutionStatus:
        s.write === 'receiver-reverted' ? 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED' : 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS',
      txHash: Buffer.from('11'.repeat(32), 'hex').toString('base64'),
    };
  };
  const http = HttpActionsMock.testInstance();
  const requests: Request[] = [];
  http.sendRequest = (req) => {
    requests.push(req);
    const r = s.http
      ? s.http(req)
      : req.url.endsWith(`timestamp=${ANCHOR}`)
        ? { statusCode: 200, body: answer(ANCHOR, ANCHOR_REPORT) }
        : { statusCode: 200, body: answer(Number(CLOSE), CLOSE_REPORT) };
    return { statusCode: r.statusCode, body: b64(r.body), headers: r.headers ?? {} };
  };
  const runtime = newTestRuntime<Config>(s.withSecrets === false ? null : secrets(), { timeProvider: () => NOW_MS }, {
    ...config,
    adapterAddress: s.adapter ?? ADAPTER,
  });
  return { runtime, reads, writes, requests, inner3 };
}

describe('initWorkflow', () => {
  test('one cron handler on the configured schedule', () => {
    const handlers = initWorkflow(config);
    expect(handlers).toHaveLength(1);
    expect((handlers[0].trigger as unknown as { config: { schedule: string } }).config.schedule).toBe('15 * * * * *');
  });
});

describe('onCronTrigger', () => {
  test('nothing pending: one read, no fetch, no write', () => {
    const { runtime, reads, writes, requests } = setup({ pending: [] });
    expect(onCronTrigger(runtime)).toBe('nothing-due');
    expect(reads.map((r) => r.fn)).toEqual(['0x36ceb433']);
    expect(requests).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(runtime.getLogs().join('\n')).toContain('pendingSettlement() is empty');
  });

  test('pending but not yet past close + delay: nothing due, secrets never read', () => {
    const { runtime, writes, requests } = setup({ pending: [8n], withSecrets: false });
    expect(onCronTrigger(runtime)).toBe('nothing-due');
    expect(requests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test('a due round: reads at the finalized block, fetches both boundaries signed, writes (id, anchor, close) to the adapter', () => {
    const { runtime, reads, writes, requests, inner3 } = setup({ pending: [8n, 7n] });
    const out = onCronTrigger(runtime);
    expect(out).toBe(`settled round 7 tx 0x${'11'.repeat(32)}`);

    // Three EVM reads in all (SPEC §5.5a, N24: at most 3): pendingSettlement and one Multicall3 aggregate3
    // (0x82ad56cb, DURATION and one closeTimeOf per pending id) at the finalized block, then the settle
    // simulation (0x577b64a0) at the latest block.
    expect(reads.map((r) => r.fn)).toEqual(['0x36ceb433', '0x82ad56cb', '0x577b64a0']);
    expect(inner3).toEqual([
      { target: ROUNDS, fn: 'DURATION' },
      { target: ROUNDS, fn: 'closeTimeOf' },
      { target: ROUNDS, fn: 'closeTimeOf' },
    ]);
    // LAST_FINALIZED_BLOCK_NUMBER is the proto BigInt -3 (sign -1, magnitude 3); LATEST would be -2.
    expect(reads.map((r) => r.block)).toEqual(['-1:3', '-1:3', '-1:2']);

    expect(requests.map((r) => r.url)).toEqual([ORIGIN + reportPath(ANCHOR), ORIGIN + reportPath(Number(CLOSE))]);
    for (const r of requests) {
      expect(r.method).toBe('GET');
      expect(r.headers.Authorization).toBe(KEY);
      expect(r.headers['X-Authorization-Timestamp']).toBe(String(NOW_MS));
      const path = r.url.slice(ORIGIN.length);
      expect(r.headers['X-Authorization-Signature-SHA256']).toBe(hmacSha256Hex(SECRET, signingString(path, KEY, String(NOW_MS))));
    }

    expect(writes).toHaveLength(1);
    expect(writes[0].receiver).toBe(ADAPTER);
    expect(writes[0].gasLimit).toBe(1_500_000n);
    expect(decodeSettleReport(writes[0].payload)).toEqual([7n, ANCHOR_REPORT, CLOSE_REPORT]);

    // Nothing secret reaches the logs.
    const logs = runtime.getLogs().join('\n');
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain(SECRET);
  });

  test('ten pending rounds (MAX_ACTIVE_ROUNDS) still take exactly 3 EVM reads', () => {
    const { runtime, reads } = setup({ pending: Array.from({ length: 10 }, (_, i) => BigInt(i + 7)) });
    onCronTrigger(runtime);
    expect(reads).toHaveLength(3);
  });

  test('a settle simulation that reverts stops the run before any write', () => {
    const { runtime, writes } = setup({ pending: [7n], simulateRevert: true });
    expect(() => onCronTrigger(runtime)).toThrow('round 7 settle simulation failed (revert or RPC error): nothing submitted');
    expect(writes).toHaveLength(0);
  });

  test('a closeTimeOf that fails inside the batch skips only that round', () => {
    const { runtime, writes } = setup({ pending: [7n, 8n], failIds: [8n] });
    expect(onCronTrigger(runtime)).toBe(`settled round 7 tx 0x${'11'.repeat(32)}`);
    expect(writes).toHaveLength(1);
  });

  test('the due round itself failing inside the batch: nothing due, no fetch', () => {
    const { runtime, writes, requests } = setup({ pending: [7n], failIds: [7n], withSecrets: false });
    expect(onCronTrigger(runtime)).toBe('nothing-due');
    expect(requests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test('close report not published yet: waits, no write', () => {
    const { runtime, writes } = setup({
      pending: [7n],
      http: (req) => (req.url.endsWith(`timestamp=${ANCHOR}`) ? { statusCode: 200, body: answer(ANCHOR, ANCHOR_REPORT) } : { statusCode: 404, body: '' }),
    });
    expect(onCronTrigger(runtime)).toBe(`waiting-report round 7 B=${CLOSE}`);
    expect(writes).toHaveLength(0);
  });

  test('a report for the wrong second is refused before any write', () => {
    const { runtime, writes } = setup({ pending: [7n], http: () => ({ statusCode: 200, body: answer(ANCHOR + 1, ANCHOR_REPORT) }) });
    expect(() => onCronTrigger(runtime)).toThrow(`round 7 report error mismatch 200 for B=${ANCHOR}`);
    expect(writes).toHaveLength(0);
  });

  test('rejected credentials fail the run naming the reason, never the key', () => {
    const { runtime, writes } = setup({ pending: [7n], http: () => ({ statusCode: 401, body: 'bad key test-key', headers: { 'x-request-id': 'r-9' } }) });
    let msg = '';
    try {
      onCronTrigger(runtime);
    } catch (e) {
      msg = (e as Error).message;
    }
    // The request id is dropped: it can differ per node and would break identical consensus.
    expect(msg).toBe(`round 7 report error unauthorized 401 for B=${ANCHOR}`);
    expect(msg).not.toContain(KEY);
    expect(writes).toHaveLength(0);
  });

  test('settle reverting inside the adapter fails the run (the forwarder transaction itself succeeds)', () => {
    const { runtime } = setup({ pending: [7n], write: 'receiver-reverted' });
    expect(() => onCronTrigger(runtime)).toThrow('round 7 adapter or settle reverted');
  });

  test('a reverted write transaction fails the run', () => {
    const { runtime } = setup({ pending: [7n], write: 'tx-reverted' });
    expect(() => onCronTrigger(runtime)).toThrow('round 7 write failed: status REVERTED');
  });

  test('adapter not deployed: stops at the write with a clear error, after the reports were checked', () => {
    const { runtime, writes, requests } = setup({ pending: [7n], adapter: '' });
    expect(() => onCronTrigger(runtime)).toThrow('config.adapterAddress is empty');
    expect(requests).toHaveLength(2);
    expect(writes).toHaveLength(0);
  });

  test('a due round with no secrets configured fails before any fetch', () => {
    const { runtime, requests } = setup({ pending: [7n], withSecrets: false });
    expect(() => onCronTrigger(runtime)).toThrow();
    expect(requests).toHaveLength(0);
  });
});
