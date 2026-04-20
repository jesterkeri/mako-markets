import { createPublicClient, http, parseAbiItem, formatEther } from 'viem';

const RPC = process.env.MONAD_RPC_URL;
if (!RPC) {
  console.error('MONAD_RPC_URL not set');
  process.exit(1);
}
const CONTRACT = '0x9d4d399D2fca1432337C5e606D005DEfa2EB4992';
const CHUNK = 1000n;
const CONCURRENCY = 5;

// Block boundaries approximating 2026-04-16 UTC (overshoots slightly on both ends)
const FROM_BLOCK = 25_700_000n;
const TO_BLOCK = 25_914_000n;
const TS_START = 1776297600n; // 2026-04-16 00:00:00 UTC
const TS_END = 1776384000n;   // 2026-04-17 00:00:00 UTC

const events = [
  parseAbiItem('event BetPlaced(uint256 indexed id, address indexed user, bool isYes, uint256 amount)'),
  parseAbiItem('event Claimed(uint256 indexed id, address indexed user, uint256 amount)'),
  parseAbiItem('event CreatorFeePaid(uint256 indexed id, address indexed creator, uint256 amount)'),
  parseAbiItem('event MarketCreated(uint256 indexed id, address indexed creator, uint8 mType, bytes32 oracleRef, uint64 closeTime, string question)'),
  parseAbiItem('event MarketResolved(uint256 indexed id, uint8 outcome)'),
  parseAbiItem('event TreasuryWithdrawn(uint256 amount)'),
];

const monad = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
};
const client = createPublicClient({ chain: monad, transport: http(RPC) });

const chunks = [];
for (let start = FROM_BLOCK; start <= TO_BLOCK; start += CHUNK) {
  const end = start + CHUNK - 1n > TO_BLOCK ? TO_BLOCK : start + CHUNK - 1n;
  chunks.push([start, end]);
}

const tasks = [];
for (const event of events) {
  for (const [from, to] of chunks) tasks.push({ event, from, to });
}
console.error(`Scanning ${chunks.length} chunks × ${events.length} events = ${tasks.length} RPC calls`);

const allLogs = [];
let done = 0;
for (let i = 0; i < tasks.length; i += CONCURRENCY) {
  const batch = tasks.slice(i, i + CONCURRENCY);
  const results = await Promise.allSettled(
    batch.map((t) =>
      client.getLogs({ address: CONTRACT, event: t.event, fromBlock: t.from, toBlock: t.to }),
    ),
  );
  for (const r of results) if (r.status === 'fulfilled') allLogs.push(...r.value);
  done += batch.length;
  if (done % 50 === 0 || done === tasks.length) process.stderr.write(`  ${done}/${tasks.length}\n`);
}

// Unique block numbers to fetch timestamps for
const uniqBlocks = [...new Set(allLogs.map((l) => l.blockNumber))];
console.error(`Unique blocks with events: ${uniqBlocks.length}`);
const tsMap = new Map();
for (let i = 0; i < uniqBlocks.length; i += 10) {
  const batch = uniqBlocks.slice(i, i + 10);
  const blocks = await Promise.all(batch.map((b) => client.getBlock({ blockNumber: b })));
  for (const b of blocks) tsMap.set(b.number, b.timestamp);
}

const april16 = allLogs.filter((l) => {
  const ts = tsMap.get(l.blockNumber);
  return ts !== undefined && ts >= TS_START && ts < TS_END;
});

const byName = {};
for (const log of april16) byName[log.eventName] = (byName[log.eventName] ?? 0) + 1;

let betTotal = 0n, claimTotal = 0n, feeTotal = 0n, treasuryTotal = 0n;
for (const log of april16) {
  const amt = log.args?.amount;
  if (!amt) continue;
  if (log.eventName === 'BetPlaced') betTotal += amt;
  else if (log.eventName === 'Claimed') claimTotal += amt;
  else if (log.eventName === 'CreatorFeePaid') feeTotal += amt;
  else if (log.eventName === 'TreasuryWithdrawn') treasuryTotal += amt;
}

console.log(`\n=== 2026-04-16 UTC activity on MakoMarkets ===`);
console.log(`Contract: ${CONTRACT}`);
console.log(`Total events on the 16th: ${april16.length}`);
console.log(`By event:`, byName);
console.log(`\nMON flows on 2026-04-16 UTC:`);
console.log(`  Bets IN:           ${formatEther(betTotal)} MON`);
console.log(`  Claims OUT:        ${formatEther(claimTotal)} MON`);
console.log(`  Creator fees OUT:  ${formatEther(feeTotal)} MON`);
console.log(`  Treasury OUT:      ${formatEther(treasuryTotal)} MON`);

if (april16.length > 0) {
  console.log(`\nAll events on the 16th (chronological):`);
  april16.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  for (const log of april16) {
    const ts = tsMap.get(log.blockNumber);
    const date = new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const marketId = log.args?.id?.toString() ?? '-';
    const user = log.args?.user ?? log.args?.creator ?? '-';
    const amt = log.args?.amount ? formatEther(log.args.amount) + ' MON' : '';
    console.log(`  ${date} UTC  ${log.eventName.padEnd(16)} market=#${marketId} ${user} ${amt} tx=${log.transactionHash}`);
  }
}
