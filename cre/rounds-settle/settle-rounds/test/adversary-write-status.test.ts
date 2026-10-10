// Adversary pass on how the handler reads the EVM write reply, 2026-10-10.
//
// main.ts says "The forwarder does not revert when the receiver does ... A settle revert shows up only here",
// i.e. only in receiverContractExecutionStatus. In the SDK's own proto that field is OPTIONAL
// (client_pb.d.ts: `optional ... receiver_contract_execution_status = 2`), so a reply can carry
// TX_STATUS_SUCCESS and no receiver status at all. Then nothing says whether settle ran. The handler compares
// `=== REVERTED` only, so an unknown receiver outcome is reported as "settled": SPEC §5.5 step 3/4 and N20
// require submit-nothing / retry / alert on failure, which needs the run to fail when the outcome is unknown.
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

describe('adversary: write reply without a receiver execution status', () => {
  test('adversary-unknown-receiver-status: a reply that does not say whether settle ran is not reported as settled', () => {
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
    const adapter = addContractMock(evm, { address: ADAPTER, abi: parseAbi(['function onReport(bytes metadata, bytes report)']) });
    // Transaction mined, receiver outcome absent (the proto field is optional).
    adapter.writeReport = () => ({ txStatus: 'TX_STATUS_SUCCESS', txHash: Buffer.from('11'.repeat(32), 'hex').toString('base64') });
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

    let outcome: string;
    try {
      outcome = onCronTrigger(runtime);
    } catch (e) {
      outcome = `threw: ${(e as Error).message}`;
    }
    expect(outcome).not.toMatch(/^settled/);
  });
});
