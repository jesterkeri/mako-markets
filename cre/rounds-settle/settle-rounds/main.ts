// rounds-settle: a Chainlink CRE workflow that settles Mako's BTC "rounds" (MakoRoundsV1 on Monad testnet)
// with Chainlink Data Streams reports.
//
//   cron (every minute)
//     -> 2 EVM reads at the last finalized block: MakoRoundsV1.pendingSettlement(), then DURATION() and every
//        closeTimeOf(id) in one Multicall3 aggregate3
//     -> pick one round that is due (logic.ts: dueRounds + pickRound)
//     -> HTTP GET, Data Streams REST: the BTC/USD full reports observed at exactly startTime and closeTime
//     -> runtime.report(abi.encode(roundId, anchorReport, closeReport)), signed by the DON
//     -> EVM write to MakoRoundsCreAdapter.onReport, which calls MakoRoundsV1.settle(...)
//
// The workflow never computes a price or an outcome. MakoRoundsV1 verifies both reports on-chain through
// Chainlink's VerifierProxy and derives everything, so a wrong report costs a revert, never a wrong result.

import {
  bytesToHex,
  consensusIdenticalAggregation,
  CronCapability,
  encodeCallMsg,
  EVMClient,
  getHeader,
  getNetwork,
  handler,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  Runner,
  text,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk';
import { EVM_PB } from '@chainlink/cre-sdk/pb';
import { zeroAddress, type Address, type Hex } from 'viem';
import {
  candidateIds,
  checkConfig,
  decodePending,
  decodeRoundTimes,
  dueRounds,
  encodeSettleReport,
  MAX_CLOSE_READS,
  MULTICALL3,
  pendingSettlementData,
  pickRound,
  readReport,
  reportHeaders,
  reportPath,
  roundTimesData,
  type Config,
  type ReportResult,
} from './logic';

export type { Config };

/// Secret NAMES only (secrets.yaml maps each to an environment variable; Joshua supplies the values).
export const SECRET_API_KEY = 'DATASTREAMS_API_KEY';
export const SECRET_API_SECRET = 'DATASTREAMS_API_SECRET';

const readAt = (runtime: Runtime<Config>, evm: EVMClient, to: Address, data: Hex): Hex => {
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to, data }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  return bytesToHex(reply.data);
};

/// Runs on every node. Returns the ReportResult as a JSON string so consensus can require every node to have
/// seen the identical answer: the same report bytes, or the same failure kind. Never returns the request,
/// headers or the provider's text.
const fetchReport = (
  sendRequester: HTTPSendRequester,
  url: string,
  headers: Record<string, string>,
  boundary: number,
): string => {
  const response = sendRequester.sendRequest({ url, method: 'GET', headers }).result();
  const requestId = getHeader(response, 'x-request-id') ?? null;
  return JSON.stringify(readReport(response.statusCode, text(response), requestId, boundary));
};

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const cfg = checkConfig(runtime.config);
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName });
  if (!network) throw new Error(`unknown chain selector name: ${cfg.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);

  // 1. Which rounds await settlement, read at the last finalized block.
  const pending = decodePending(readAt(runtime, evm, cfg.roundsAddress, pendingSettlementData()));
  if (pending.length === 0) {
    runtime.log('nothing due: pendingSettlement() is empty');
    return 'nothing-due';
  }
  const nowS = Math.floor(runtime.now().getTime() / 1000);
  // 2nd and last EVM read: DURATION() and every close time, in one Multicall3 aggregate3 at the same block tag.
  const ids = candidateIds(pending, nowS, MAX_CLOSE_READS);
  const { duration, closeTimes } = decodeRoundTimes(readAt(runtime, evm, MULTICALL3, roundTimesData(cfg.roundsAddress, ids)), ids);
  const due = pickRound(dueRounds(pending, closeTimes, duration, nowS, cfg.settleDelaySeconds), nowS);
  if (due === null) {
    runtime.log(`nothing due: ${pending.length} pending, none ${cfg.settleDelaySeconds}s past close yet`);
    return 'nothing-due';
  }
  const round = `round ${due.roundId}`;
  runtime.log(`${round} due: anchor B=${due.anchorAt}, close B=${due.closeAt}`);

  // 2. Both Data Streams reports. Secrets are read only now, when there is something to fetch.
  const apiKey = runtime.getSecret({ id: SECRET_API_KEY }).result().value;
  const apiSecret = runtime.getSecret({ id: SECRET_API_SECRET }).result().value;
  const http = new HTTPClient();
  const reports: Hex[] = [];
  for (const boundary of [due.anchorAt, due.closeAt]) {
    const path = reportPath(boundary);
    // DON time, identical on every node, so every node signs the same request.
    const headers = reportHeaders(path, apiKey, apiSecret, String(runtime.now().getTime()));
    const answer = http
      .sendRequest(runtime, fetchReport, consensusIdenticalAggregation<string>())(cfg.dataStreamsUrl + path, headers, boundary)
      .result();
    const r = JSON.parse(answer) as ReportResult;
    if (!r.ok) {
      if (r.reason === 'not_found') {
        runtime.log(`${round} waiting: no report yet for B=${boundary}`);
        return `waiting-report ${round} B=${boundary}`;
      }
      throw new Error(`${round} report error ${r.reason} ${r.status}${r.requestId ? ` ${r.requestId}` : ''} for B=${boundary}`);
    }
    reports.push(r.fullReport);
  }
  runtime.log(`${round} both reports fetched and checked (feed, exact boundary)`);

  // 3. DON-signed report -> forwarder -> adapter.onReport -> MakoRoundsV1.settle.
  if (cfg.adapterAddress === null) {
    throw new Error(`${round} ready to settle, but config.adapterAddress is empty: deploy MakoRoundsCreAdapter and set it`);
  }
  const report = runtime.report(prepareReportRequest(encodeSettleReport(due.roundId, reports[0], reports[1]))).result();
  const reply = evm
    .writeReport(runtime, { receiver: cfg.adapterAddress, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result();
  const txHash = bytesToHex(reply.txHash ?? new Uint8Array(32));
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`${round} write failed: status ${TxStatus[reply.txStatus]}${reply.errorMessage ? ` (${reply.errorMessage})` : ''}`);
  }
  // The forwarder does not revert when the receiver does: it records the failure and the transaction
  // succeeds. A settle revert (already settled, spread too wide, wrong report) shows up only here.
  if (reply.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) {
    throw new Error(`${round} adapter or settle reverted, tx ${txHash}`);
  }
  runtime.log(`${round} settle submitted, tx ${txHash}`);
  return `settled ${round} tx ${txHash}`;
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
