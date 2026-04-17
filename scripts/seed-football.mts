#!/usr/bin/env tsx
/**
 * scripts/seed-football.mts — surgical football seed, additive.
 *
 * Fetches upcoming scheduled matches from football-data.org (7-day window,
 * matching the contract's MAX_DURATION cap) and creates up to `LIMIT`
 * home_win markets on-chain, skipping matchIds already seeded.
 *
 * Why curl instead of fetch: Node 25 on this macOS host has a TLS
 * handshake issue with certain upstreams (balldontlie is broken; football-
 * data.org hasn't been tested but we keep the curl pattern consistent
 * across seed-* scripts so a future host-level fix doesn't leave one
 * script in a different code path).
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-football.mts           # up to 2
 *   LIMIT=4 pnpm exec tsx scripts/seed-football.mts   # up to 4
 *
 * Requires in .env.local:
 *   ADMIN_PRIVATE_KEY=0x...
 *   MAKO_ADDRESS=0x...
 *   FOOTBALL_DATA_API_KEY=...
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import {
  createPublicClient,
  createWalletClient,
  http,
  stringToHex,
  hexToString,
  pad,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function fail(msg: string): never {
  console.error(`[seed-football] FATAL: ${msg}`);
  process.exit(1);
}

const RPC_URL = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz/';

const rawAddr = process.env.MAKO_ADDRESS;
if (!rawAddr || !/^0x[a-fA-F0-9]{40}$/.test(rawAddr)) {
  fail('MAKO_ADDRESS missing or malformed in .env.local');
}
const MAKO_ADDRESS = rawAddr as Address;

const rawKey = process.env.ADMIN_PRIVATE_KEY;
if (!rawKey || !/^0x[a-fA-F0-9]{64}$/.test(rawKey)) {
  fail('ADMIN_PRIVATE_KEY missing or malformed in .env.local');
}
const ADMIN_PRIVATE_KEY = rawKey as Hex;

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
if (!FOOTBALL_DATA_API_KEY) {
  fail('FOOTBALL_DATA_API_KEY not set in .env.local');
}

const LIMIT = Math.max(1, Math.min(10, Number(process.env.LIMIT ?? '2')));

const __dirname = dirname(fileURLToPath(import.meta.url));
const abiJson = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../mako-contracts/out/MakoMarkets.sol/MakoMarkets.json'),
    'utf-8',
  ),
) as { abi: readonly unknown[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makoAbi = abiJson.abi as any;

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] },
  },
} as const;

const account = privateKeyToAccount(ADMIN_PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  chain: monadTestnet,
  transport: http(RPC_URL),
});
const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL),
});

console.log(`[seed-football] deployer: ${account.address}`);
console.log(`[seed-football] contract: ${MAKO_ADDRESS}`);
console.log(`[seed-football] limit: ${LIMIT}`);

const MarketType = { FOOTBALL: 0, CRYPTO: 1, BASKETBALL: 2 } as const;

function toBytes32(s: string): Hex {
  const hex = stringToHex(s);
  const byteLength = (hex.length - 2) / 2;
  if (byteLength > 32) throw new Error(`oracleRef "${s}" is ${byteLength} bytes, max 32`);
  return pad(hex, { size: 32, dir: 'right' });
}

function matchIdFromOracleRef(ref: Hex): string | null {
  try {
    const s = hexToString(ref, { size: 32 });
    const first = s.split(':')[0];
    return /^\d+$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// Collect already-seeded football matchIds
// ---------------------------------------------------------------

const nextId = (await publicClient.readContract({
  address: MAKO_ADDRESS,
  abi: makoAbi,
  functionName: 'nextMarketId',
})) as bigint;

console.log(`[seed-football] nextMarketId: ${nextId}`);

const existingMatchIds = new Set<string>();
for (let i = 0n; i < nextId; i++) {
  const m = (await publicClient.readContract({
    address: MAKO_ADDRESS,
    abi: makoAbi,
    functionName: 'getMarket',
    args: [i],
  })) as { mType: number; oracleRef: Hex };
  if (m.mType === MarketType.FOOTBALL) {
    const mid = matchIdFromOracleRef(m.oracleRef);
    if (mid !== null) existingMatchIds.add(mid);
  }
}
console.log(
  `[seed-football] existing football markets on-chain: ${existingMatchIds.size}` +
    (existingMatchIds.size > 0 ? ` (matchIds: ${[...existingMatchIds].join(', ')})` : ''),
);

// ---------------------------------------------------------------
// Fetch upcoming SCHEDULED/TIMED matches via curl
// ---------------------------------------------------------------

interface UpcomingMatch {
  id: number;
  home: string;
  away: string;
  kickoff: Date;
  competition: string;
}

async function fetchMatchesViaCurl(): Promise<UpcomingMatch[]> {
  const now = Date.now();
  // MAX_DURATION in the contract is 7 days. Use a slightly tighter window
  // (6 days) so our closeTime (kickoff - 10m) can't slip past the cap due
  // to clock drift between machine + chain.
  const start = new Date(now).toISOString().slice(0, 10);
  const end = new Date(now + 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = `https://api.football-data.org/v4/matches?dateFrom=${start}&dateTo=${end}`;

  const { stdout } = await execFileP('curl', [
    '-sS',
    '--max-time', '20',
    '-H', `X-Auth-Token: ${FOOTBALL_DATA_API_KEY}`,
    '-H', 'Accept: application/json',
    url,
  ], { maxBuffer: 10 * 1024 * 1024 });

  let json: {
    matches?: Array<{
      id: number;
      utcDate: string;
      status: string;
      homeTeam: { name?: string; shortName?: string };
      awayTeam: { name?: string; shortName?: string };
      competition: { name?: string };
    }>;
    errorCode?: number;
    message?: string;
  };
  try {
    json = JSON.parse(stdout);
  } catch {
    console.warn(`[seed-football] failed to parse upstream body (head): ${stdout.slice(0, 200)}`);
    return [];
  }
  if (json.errorCode || !json.matches) {
    console.warn(`[seed-football] upstream error: ${json.errorCode} ${json.message ?? ''}`);
    return [];
  }

  return json.matches
    .filter((m) => m.status === 'SCHEDULED' || m.status === 'TIMED')
    .map((m) => ({
      id: m.id,
      home: m.homeTeam.shortName ?? m.homeTeam.name ?? 'Home',
      away: m.awayTeam.shortName ?? m.awayTeam.name ?? 'Away',
      kickoff: new Date(m.utcDate),
      competition: m.competition.name ?? 'Match',
    }))
    .filter((m) => m.kickoff.getTime() > now + 10 * 60 * 1000)
    .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
}

const slate = await fetchMatchesViaCurl();
console.log(`[seed-football] upcoming slate: ${slate.length} matches`);

const toSeed = slate.filter((m) => !existingMatchIds.has(String(m.id))).slice(0, LIMIT);

if (toSeed.length === 0) {
  console.log('[seed-football] nothing to seed — slate is empty or fully covered on-chain.');
  process.exit(0);
}

console.log(`[seed-football] will seed ${toSeed.length} markets:`);
for (const m of toSeed) {
  console.log(
    `  #${m.id}  ${m.away} @ ${m.home}  (${m.competition})  kickoff=${m.kickoff.toISOString()}`,
  );
}
console.log('');

// ---------------------------------------------------------------
// Create each market
// ---------------------------------------------------------------

let placedAt = Number(nextId);
for (const m of toSeed) {
  const closeTimeSec = BigInt(Math.floor(m.kickoff.getTime() / 1000) - 600);
  const question = `Will ${m.home} beat ${m.away}?`;
  if (question.length > 200) fail(`question exceeds 200 chars: "${question}"`);
  const oracleRef = toBytes32(`${m.id}:home_win:0`);

  console.log(`[seed-football] [${placedAt}] "${question}"`);
  const hash = await walletClient.writeContract({
    address: MAKO_ADDRESS,
    abi: makoAbi,
    functionName: 'createMarket',
    args: [MarketType.FOOTBALL, oracleRef, closeTimeSec, question],
  });
  console.log(`[seed-football]        tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    fail(`createMarket reverted — tx ${hash}, block ${receipt.blockNumber}`);
  }
  console.log(`[seed-football]        block ${receipt.blockNumber}, gas ${receipt.gasUsed}, OK`);
  console.log('');
  placedAt++;
}

console.log(`[seed-football] done. nextMarketId is now ${placedAt}.`);
console.log(`[seed-football]   https://testnet.monadvision.xyz/address/${MAKO_ADDRESS}`);
