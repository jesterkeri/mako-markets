#!/usr/bin/env tsx
/**
 * scripts/seed-nba.mts — surgical NBA seed, additive.
 *
 * Unlike scripts/seed.mts this does NOT bootstrap a fresh contract — it
 * appends up to `LIMIT` BASKETBALL markets to an already-seeded contract.
 * Safe to run repeatedly: it walks existing markets, extracts game IDs
 * already on-chain, and skips them.
 *
 * Why a separate script: the main seed guards against re-running via
 * `nextMarketId > 1`. Bypassing that guard would duplicate the football
 * and crypto markets every run. This one has no guard because it only
 * creates markets that don't already exist.
 *
 * Why curl instead of fetch: Node 25 on this macOS host can't complete
 * the TLS handshake to api.balldontlie.io (both `fetch` and `https.request`
 * hang; the system `curl` succeeds in ~600ms). GH Actions Ubuntu runners
 * don't hit this, so the auto-resolver keeps using fetch. This script
 * only runs locally, so shelling out is acceptable.
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-nba.mts            # adds up to 2 NBA markets
 *   LIMIT=5 pnpm exec tsx scripts/seed-nba.mts    # adds up to 5
 *
 * Requires in .env.local:
 *   ADMIN_PRIVATE_KEY=0x...
 *   MAKO_ADDRESS=0x...
 *   BALLDONTLIE_API_KEY=...
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

// ---------------------------------------------------------------
// Env + ABI
// ---------------------------------------------------------------

function fail(msg: string): never {
  console.error(`[seed-nba] FATAL: ${msg}`);
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

const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY;
if (!BALLDONTLIE_API_KEY) {
  fail('BALLDONTLIE_API_KEY not set in .env.local (required for NBA seed)');
}

const LIMIT = Math.max(1, Math.min(10, Number(process.env.LIMIT ?? '2')));

const __dirname = dirname(fileURLToPath(import.meta.url));
const abiJson = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../mako-contracts/out/MakoMarketsV4.sol/MakoMarketsV4.json'),
    'utf-8',
  ),
) as { abi: readonly unknown[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makoAbi = abiJson.abi as any;

// ---------------------------------------------------------------
// Clients
// ---------------------------------------------------------------

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

console.log(`[seed-nba] deployer: ${account.address}`);
console.log(`[seed-nba] contract: ${MAKO_ADDRESS}`);
console.log(`[seed-nba] limit: ${LIMIT}`);

// ---------------------------------------------------------------
// Encoding helpers (mirror scripts/seed.mts + oracle.ts)
// ---------------------------------------------------------------

const MarketType = { FOOTBALL: 0, CRYPTO: 1, BASKETBALL: 2 } as const;

function toBytes32(s: string): Hex {
  const hex = stringToHex(s);
  const byteLength = (hex.length - 2) / 2;
  if (byteLength > 32) throw new Error(`oracleRef "${s}" is ${byteLength} bytes, max 32`);
  return pad(hex, { size: 32, dir: 'right' });
}

/** Extract the `<gameId>` prefix from a basketball oracleRef bytes32. */
function gameIdFromOracleRef(ref: Hex): number | null {
  try {
    // hexToString with size=32 strips the zero padding back to the original string.
    const s = hexToString(ref, { size: 32 });
    const first = s.split(':')[0];
    const id = Number(first);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// 1. Walk existing markets to collect already-seeded NBA game IDs
// ---------------------------------------------------------------

const nextId = (await publicClient.readContract({
  address: MAKO_ADDRESS,
  abi: makoAbi,
  functionName: 'nextMarketId',
})) as bigint;

console.log(`[seed-nba] nextMarketId: ${nextId}`);

const existingGameIds = new Set<number>();
for (let i = 0n; i < nextId; i++) {
  const m = (await publicClient.readContract({
    address: MAKO_ADDRESS,
    abi: makoAbi,
    functionName: 'getMarket',
    args: [i],
  })) as { mType: number; oracleRef: Hex };
  if (m.mType === MarketType.BASKETBALL) {
    const gid = gameIdFromOracleRef(m.oracleRef);
    if (gid !== null) existingGameIds.add(gid);
  }
}
console.log(
  `[seed-nba] existing NBA markets on-chain: ${existingGameIds.size}` +
    (existingGameIds.size > 0 ? ` (game IDs: ${[...existingGameIds].join(', ')})` : ''),
);

// ---------------------------------------------------------------
// 2. Fetch upcoming NBA slate via curl (Node fetch blocked by TLS)
// ---------------------------------------------------------------

interface UpcomingNbaGame {
  id: number;
  home: string;
  away: string;
  kickoff: Date;
}

async function fetchNbaSlateViaCurl(): Promise<UpcomingNbaGame[]> {
  const now = Date.now();
  const start = new Date(now).toISOString().slice(0, 10);
  const end = new Date(now + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = `https://api.balldontlie.io/v1/games?start_date=${start}&end_date=${end}&per_page=100`;
  const { stdout } = await execFileP('curl', [
    '-sS',
    '--max-time', '20',
    '-H', `Authorization: ${BALLDONTLIE_API_KEY}`,
    '-H', 'Accept: application/json',
    url,
  ], { maxBuffer: 10 * 1024 * 1024 });
  const json = JSON.parse(stdout) as {
    data?: Array<{
      id: number;
      date: string;
      datetime?: string;
      status?: string;
      home_team: { full_name: string };
      visitor_team: { full_name: string };
    }>;
  };
  return (json.data ?? [])
    .filter((g) => !g.status || !g.status.startsWith('Final'))
    .map((g) => ({
      id: g.id,
      home: g.home_team.full_name,
      away: g.visitor_team.full_name,
      kickoff: new Date(g.datetime ?? g.date),
    }))
    .filter((g) => g.kickoff.getTime() > now + 10 * 60 * 1000)
    .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
}

const slate = await fetchNbaSlateViaCurl();
console.log(`[seed-nba] upcoming slate: ${slate.length} games`);

// Filter out games already on-chain, then take `LIMIT`.
const toSeed = slate.filter((g) => !existingGameIds.has(g.id)).slice(0, LIMIT);

if (toSeed.length === 0) {
  console.log('[seed-nba] nothing to seed — slate is empty or fully covered on-chain.');
  process.exit(0);
}

console.log(`[seed-nba] will seed ${toSeed.length} markets:`);
for (const g of toSeed) {
  console.log(`  #${g.id}  ${g.away} @ ${g.home}  kickoff=${g.kickoff.toISOString()}`);
}
console.log('');

// ---------------------------------------------------------------
// 3. Create each market: oracleRef=<gameId>:home_win:0, closeTime=kickoff-10m
// ---------------------------------------------------------------

// MIRROR of src/lib/market-timing.ts:sportsTimestamps('basketball', ...) +
// validateMarketTimestamps — inlined because tsx/ESM can't import from
// src/. PRE_EVENT_BUFFER_SEC=600, BASKETBALL_DURATION_SEC=10800 (3h),
// MAX_DURATION_SEC=604800 (7d), MIN_DURATION_SEC=300 (5m). If the lib
// changes, update here.
const PRE_EVENT_BUFFER_SEC = 10 * 60;
const BASKETBALL_DURATION_SEC = 180 * 60;
const MAX_DURATION_SEC = 7 * 24 * 60 * 60;
const MIN_DURATION_SEC = 5 * 60;

function assertSportsTimestamps(
  nowSec: number,
  bettingCloseTime: bigint,
  closeTime: bigint,
): void {
  const now = BigInt(nowSec);
  if (bettingCloseTime <= now) fail('bettingCloseTime must be in the future');
  if (closeTime <= now) fail('closeTime must be in the future');
  if (bettingCloseTime >= closeTime) fail('bettingCloseTime must be strictly before closeTime');
  const durationSec = Number(closeTime - now);
  if (durationSec < MIN_DURATION_SEC) fail('event too soon (< MIN_DURATION)');
  if (durationSec > MAX_DURATION_SEC) fail('event too far out (> MAX_DURATION)');
}

let placedAt = Number(nextId);
for (const g of toSeed) {
  const tipoffSec = Math.floor(g.kickoff.getTime() / 1000);
  const bettingCloseTime = BigInt(tipoffSec - PRE_EVENT_BUFFER_SEC);
  const closeTime = BigInt(tipoffSec + BASKETBALL_DURATION_SEC);
  const question = `Will the ${g.home} beat the ${g.away}?`;
  const oracleRef = toBytes32(`${g.id}:home_win:0`);

  assertSportsTimestamps(Math.floor(Date.now() / 1000), bettingCloseTime, closeTime);

  console.log(`[seed-nba] [${placedAt}] "${question}"`);
  const hash = await walletClient.writeContract({
    address: MAKO_ADDRESS,
    abi: makoAbi,
    functionName: 'createMarket',
    args: [MarketType.BASKETBALL, oracleRef, bettingCloseTime, closeTime, question],
  });
  console.log(`[seed-nba]        tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    fail(`createMarket reverted — tx ${hash}, block ${receipt.blockNumber}`);
  }
  console.log(`[seed-nba]        block ${receipt.blockNumber}, gas ${receipt.gasUsed}, OK`);
  console.log('');
  placedAt++;
}

console.log(`[seed-nba] done. nextMarketId is now ${placedAt}.`);
console.log(`[seed-nba]   https://testnet.monadvision.xyz/address/${MAKO_ADDRESS}`);
