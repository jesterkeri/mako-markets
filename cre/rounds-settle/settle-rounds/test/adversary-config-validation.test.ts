// Adversary pass r6 on checkConfig (logic.ts, commit 955404e), 2026-10-10.
//
// logic.ts Config: dataStreamsUrl is the "Data Streams REST origin, HTTPS, no trailing slash", and checkConfig
// refuses anything else with "config.dataStreamsUrl must be an https origin with no path or trailing slash".
// The check is the regex ^https://[^/\s]+$, which also accepts a userinfo part. In
// "https://api.testnet-dataengine.chain.link@attacker.example" everything before "@" is a user name, so the
// host is attacker.example, yet the string reads as the Chainlink host in a config diff. main.ts sends every
// report request, with the Data Streams API key in the Authorization header, to cfg.dataStreamsUrl + path.
//
// SPEC §5.5a "Transaction gas | 5,000,000" is the CRE quota per write; checkConfig accepts gasLimit up to
// 99,999,999. SPEC §5.5 step 1 "take one round": checkConfig accepts settleDelaySeconds = 86400, at which
// no round is ever due inside its SUBMIT_WINDOW (pendingSettlement drops it at close + 86400), and every
// run ends as a successful "nothing-due".
//
// The test-only key below is a sentinel, not a credential.
import { describe, expect } from 'bun:test';
import { EvmMock, HttpActionsMock, newTestRuntime, test, addContractMock } from '@chainlink/cre-sdk/test';
import type { HTTP_CLIENT_PB } from '@chainlink/cre-sdk/pb';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { onCronTrigger, SECRET_API_KEY, SECRET_API_SECRET } from '../main';
import { checkConfig, dueRounds, MULTICALL3, MULTICALL3_ABI, ROUNDS_ABI, type Config } from '../logic';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const MONAD_TESTNET_SELECTOR = 2183018362218727504n;
const ROUNDS = '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921';
const CLOSE = BigInt(fixture.observationsTimestamp);
const SENTINEL_KEY = 'adversary-sentinel-key';

const good: Config = {
  schedule: '15 * * * * *',
  chainSelectorName: 'monad-testnet',
  roundsAddress: ROUNDS,
  adapterAddress: '',
  dataStreamsUrl: 'https://api.testnet-dataengine.chain.link',
  settleDelaySeconds: 10,
  gasLimit: '1500000',
};

describe('adversary: config validation', () => {
  test('adversary-origin-userinfo: the API key is only ever sent to the configured origin host', () => {
    const lookalike = 'https://api.testnet-dataengine.chain.link@attacker.example';
    let accepted = true;
    try {
      checkConfig({ ...good, dataStreamsUrl: lookalike });
    } catch {
      accepted = false;
    }
    // If checkConfig accepts it, show where the run sends the key.
    const sent: { host: string; authorization: string }[] = [];
    if (accepted) {
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
      const http = HttpActionsMock.testInstance();
      http.sendRequest = (req: HTTP_CLIENT_PB.Request) => {
        sent.push({ host: new URL(req.url).hostname, authorization: req.headers.Authorization });
        return { statusCode: 404, body: '', headers: {} };
      };
      const runtime = newTestRuntime<Config>(
        new Map([['main', new Map([[SECRET_API_KEY, SENTINEL_KEY], [SECRET_API_SECRET, 'adversary-sentinel-secret']])]]),
        { timeProvider: () => (Number(CLOSE) + 60) * 1000 },
        { ...good, dataStreamsUrl: lookalike },
      );
      onCronTrigger(runtime);
    }
    // An origin is scheme + host (+ port): whatever checkConfig accepts must equal its own WHATWG origin.
    expect({ accepted, keySentTo: sent.map((s) => `${s.host} (${s.authorization})`) }).toEqual({ accepted: false, keySentTo: [] });
  });

  test('adversary-gas-over-quota: a gasLimit above the CRE transaction gas quota (SPEC §5.5a, 5,000,000) is refused', () => {
    expect(() => checkConfig({ ...good, gasLimit: '99999999' })).toThrow(/gasLimit/);
  });

  test('adversary-delay-never-due: a settleDelaySeconds that leaves no round ever due is refused', () => {
    // With delay 86400, a round in pendingSettlement() (block.timestamp in [close, close + 86400)) is never due.
    const delay = 86_400;
    let dueRuns = 0;
    for (let nowS = Number(CLOSE) + 15; nowS < Number(CLOSE) + 86_400; nowS += 60) {
      if (dueRounds([7n], new Map([[7n, CLOSE]]), 900n, nowS, delay).length > 0) dueRuns++;
    }
    expect(dueRuns).toBe(0); // the premise: a settleable round is skipped on every one of its 1,440 runs
    expect(() => checkConfig({ ...good, settleDelaySeconds: delay })).toThrow(/settleDelaySeconds/);
  });
});
