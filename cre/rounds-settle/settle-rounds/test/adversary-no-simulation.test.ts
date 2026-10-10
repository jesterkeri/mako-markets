// Adversary pass on what the handler checks before it writes, 2026-10-10.
//
// SPEC §5.5 step 3: "Simulate `verify` for both with `eth_call`, and simulate `settle`; submit only if both pass."
// INVARIANTS N20: "A courier submits nothing when a report is missing, a `verify` or `settle` simulation fails".
// The keeper does this (origin/feat/rounds-keeper keeper/src/run.ts: eth_call + eth_estimateGas, status
// 'simulation-reverted'). The CRE path has one EVM read left in its SPEC §5.5a budget for it.
//
// Scenario: a due round whose settle reverts for these reports (the fee manager has been switched on, the
// spread is too wide, or the keeper settled it a moment ago). Every eth_call of settle reverts, as it would on
// chain, whether made to MakoRoundsV1 directly or inside a Multicall3 aggregate3. The run must not write.
import { describe, expect } from 'bun:test';
import { EvmMock, HttpActionsMock, newTestRuntime, test, addContractMock } from '@chainlink/cre-sdk/test';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem';
import { onCronTrigger, SECRET_API_KEY, SECRET_API_SECRET } from '../main';
import { FEED_ID, MULTICALL3, MULTICALL3_ABI, ROUNDS_ABI, type Config } from '../logic';
import fixture from './fixtures/fixture-btcusd-1789529160.json';

const MONAD_TESTNET_SELECTOR = 2183018362218727504n;
const ROUNDS = '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921';
const ADAPTER = '0x00000000000000000000000000000000000000aa';
const CLOSE = BigInt(fixture.observationsTimestamp);
const ANCHOR = Number(CLOSE) - 900;
const CLOSE_REPORT = fixture.fullReport.toLowerCase() as Hex;
// Synthetic anchor bytes, as in main.test.ts: readReport checks the JSON envelope only.
const ANCHOR_REPORT = `0x${'ab'.repeat(64)}` as Hex;

const config: Config = {
  schedule: '15 * * * * *',
  chainSelectorName: 'monad-testnet',
  roundsAddress: ROUNDS,
  adapterAddress: ADAPTER,
  dataStreamsUrl: 'https://api.testnet-dataengine.chain.link',
  settleDelaySeconds: 10,
  gasLimit: '1500000',
};

const answer = (boundary: number, fullReport: Hex) =>
  JSON.stringify({ report: { feedID: FEED_ID, observationsTimestamp: boundary, validFromTimestamp: boundary, fullReport } });

describe('adversary: settle that would revert', () => {
  test('adversary-no-settle-simulation: a round whose settle reverts in simulation is not submitted', () => {
    const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR);
    const rounds = addContractMock(evm, { address: ROUNDS, abi: ROUNDS_ABI });
    rounds.pendingSettlement = () => [7n];
    rounds.DURATION = () => 900n;
    rounds.closeTimeOf = () => CLOSE;
    // eth_call of settle reverts, as MakoRoundsV1 does with FeeManagerEnabled / SpreadTooWide / RoundAlreadyTerminal.
    // settle is not a view, so the typed mock does not list it; the runtime mock routes any ABI function.
    (rounds as unknown as Record<string, () => never>).settle = () => {
      throw new Error('execution reverted');
    };
    const multicall = addContractMock(evm, { address: MULTICALL3, abi: MULTICALL3_ABI });
    multicall.aggregate3 = (calls: unknown) =>
      (calls as { callData: Hex }[]).map((c) => {
        const d = decodeFunctionData({ abi: ROUNDS_ABI, data: c.callData });
        if (d.functionName === 'DURATION')
          return { success: true, returnData: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'DURATION', result: 900n }) };
        if (d.functionName === 'closeTimeOf')
          return { success: true, returnData: encodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'closeTimeOf', result: CLOSE }) };
        return { success: false, returnData: '0x' as Hex };
      });
    const adapter = addContractMock(evm, { address: ADAPTER, abi: parseAbi(['function onReport(bytes metadata, bytes report)']) });
    // An eth_call of onReport through the adapter reverts too (the adapter forwards settle's revert).
    (adapter as unknown as Record<string, () => never>).onReport = () => {
      throw new Error('execution reverted');
    };
    let writes = 0;
    adapter.writeReport = () => {
      writes += 1;
      return {
        txStatus: 'TX_STATUS_SUCCESS',
        receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED',
        txHash: Buffer.from('11'.repeat(32), 'hex').toString('base64'),
      };
    };
    const http = HttpActionsMock.testInstance();
    http.sendRequest = (req) => ({
      statusCode: 200,
      body: Buffer.from(req.url.endsWith(`timestamp=${ANCHOR}`) ? answer(ANCHOR, ANCHOR_REPORT) : answer(Number(CLOSE), CLOSE_REPORT)).toString('base64'),
      headers: {},
    });
    const runtime = newTestRuntime<Config>(
      new Map([['main', new Map([[SECRET_API_KEY, 'test-key'], [SECRET_API_SECRET, 'test-secret']])]]),
      { timeProvider: () => (Number(CLOSE) + 60) * 1000 },
      config,
    );

    try {
      onCronTrigger(runtime);
    } catch {
      // Ending the run with an error is acceptable; writing is not.
    }
    expect({ writeReportCalls: writes }).toEqual({ writeReportCalls: 0 });
  });
});
