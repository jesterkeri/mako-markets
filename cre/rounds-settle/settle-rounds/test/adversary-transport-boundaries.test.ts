// Adversary pass on the report-fetch boundaries (Codex CRE R1 fix 4062c8b), 2026-10-10.
//
// SPEC §5.5/N20 as stated in the review: a report-fetch failure must be canonical BEFORE it crosses node-mode
// consensus or the workflow boundary. main.ts guards two places with withoutThrow: inside the node callback
// (fetchReport) and around the consensus .result(). The test added in 4062c8b throws from the HTTP mock only, so
// either guard alone makes it pass: deleting the inner guard (the raw diagnostic, key and signature included, then
// travels to consensus as the node's error observation) or deleting the outer one leaves all 56 tests green.
// These two tests pin each boundary on its own: the first reads what each node hands to consensus, the second
// makes consensus itself fail with a diagnostic and checks that nothing of it reaches the run's error or logs.
import { describe, expect } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { anyPack, anyUnpack } from '@bufbuild/protobuf/wkt';
import { SDK_PB, VALUES_PB } from '@chainlink/cre-sdk/pb';
import { addContractMock, EvmMock, HttpActionsMock, newTestRuntime, registerTestCapability, test } from '@chainlink/cre-sdk/test';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { onCronTrigger, SECRET_API_KEY, SECRET_API_SECRET } from '../main';
import { FEED_ID, MULTICALL3, MULTICALL3_ABI, ROUNDS_ABI, TRANSPORT_FAILURE, type Config } from '../logic';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const MONAD_TESTNET_SELECTOR = 2183018362218727504n;
const ROUNDS = '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921';
const ADAPTER = '0x00000000000000000000000000000000000000aa';
const CLOSE = BigInt(fixture.observationsTimestamp);
const ANCHOR = Number(CLOSE) - 900;
// Planted sentinels, not credentials: they exist only so a leak is detectable.
const KEY = 'adversary-sentinel-api-key';
const SECRET = 'adversary-sentinel-api-secret';

const config: Config = {
  schedule: '15 * * * * *',
  chainSelectorName: 'monad-testnet',
  roundsAddress: ROUNDS,
  adapterAddress: ADAPTER,
  dataStreamsUrl: 'https://api.testnet-dataengine.chain.link',
  settleDelaySeconds: 10,
  gasLimit: '1500000',
};

type Observation = { case: string | undefined; text: string };

/// Round 7 is due. Consensus is replaced by a recording one: 'echo' behaves like the SDK default (a value
/// observation passes through, an error observation fails consensus with its text); { fail } fails every
/// consensus call with that diagnostic.
function setup(consensus: 'echo' | { fail: string }, http: (req: { url: string; headers: Record<string, string> }) => never | { statusCode: number; body: string }) {
  const observations: Observation[] = [];
  registerTestCapability('consensus@1.0.0-alpha', (req) => {
    if (req.method !== 'Simple') return { response: { case: 'error', value: `unexpected consensus method ${req.method}` } };
    const input = anyUnpack(req.payload, SDK_PB.SimpleConsensusInputsSchema)!;
    const obs = input.observation;
    const text = obs.case === 'value' ? String(obs.value.value.value) : String(obs.value);
    observations.push({ case: obs.case, text });
    if (consensus !== 'echo') return { response: { case: 'error', value: consensus.fail } };
    if (obs.case !== 'value') return { response: { case: 'error', value: text } };
    return { response: { case: 'payload', value: anyPack(VALUES_PB.ValueSchema, create(VALUES_PB.ValueSchema, { value: obs.value.value })) } };
  });

  const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR);
  const rounds = addContractMock(evm, { address: ROUNDS, abi: ROUNDS_ABI });
  rounds.pendingSettlement = () => [7n];
  const multicall = addContractMock(evm, { address: MULTICALL3, abi: MULTICALL3_ABI });
  multicall.aggregate3 = (calls: unknown) =>
    (calls as { callData: Hex }[]).map((c) => {
      const d = decodeFunctionData({ abi: ROUNDS_ABI, data: c.callData });
      return d.functionName === 'DURATION'
        ? { success: true, returnData: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'DURATION', result: 900n }) }
        : { success: true, returnData: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'closeTimeOf', result: CLOSE }) };
    });
  const mock = HttpActionsMock.testInstance();
  mock.sendRequest = (req) => {
    const r = http(req);
    return { statusCode: r.statusCode, body: Buffer.from(r.body).toString('base64'), headers: {} };
  };
  const runtime = newTestRuntime<Config>(
    new Map([['main', new Map([[SECRET_API_KEY, KEY], [SECRET_API_SECRET, SECRET]])]]),
    { timeProvider: () => (Number(CLOSE) + 60) * 1000 },
    config,
  );
  return { runtime, observations };
}

function run(runtime: ReturnType<typeof setup>['runtime']): string {
  try {
    return `returned ${onCronTrigger(runtime)}`;
  } catch (e) {
    const err = e as Error & { cause?: unknown };
    return `${err.message}\n${err.stack ?? ''}\n${String(err.cause ?? '')}`;
  }
}

describe('adversary: each report-fetch boundary holds on its own', () => {
  test('adversary-node-observation-canonical: a throwing fetch hands consensus the fixed TRANSPORT_FAILURE, never its diagnostic', () => {
    let signature = '';
    const { runtime, observations } = setup('echo', (req) => {
      signature = req.headers['X-Authorization-Signature-SHA256'];
      throw new Error(`fetch failed: GET ${req.url} Authorization: ${req.headers.Authorization} sig=${signature}`);
    });
    run(runtime);
    expect(signature.length).toBeGreaterThan(10);
    // What crossed node-mode consensus: one observation, the canonical value, nothing of the request.
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual({ case: 'value', text: JSON.stringify(TRANSPORT_FAILURE) });
    for (const leak of [KEY, signature]) expect(observations[0].text).not.toContain(leak);
  });

  test('adversary-consensus-failure-canonical: a consensus failure carrying a diagnostic ends the run with the fixed transport error only', () => {
    const diagnostic = `consensus failed: node 3 observed GET /api/v1/reports Authorization: ${KEY} secret=${SECRET}`;
    const { runtime } = setup({ fail: diagnostic }, () => ({
      statusCode: 200,
      body: JSON.stringify({ report: { feedID: FEED_ID, observationsTimestamp: ANCHOR, fullReport: `0x${'ab'.repeat(64)}` } }),
    }));
    const out = run(runtime);
    expect(out.split('\n')[0]).toBe(`round 7 report error transport 0 for B=${ANCHOR}`);
    const logs = runtime.getLogs().join('\n');
    for (const leak of [KEY, SECRET, 'consensus failed']) {
      expect(out).not.toContain(leak);
      expect(logs).not.toContain(leak);
    }
  });
});
