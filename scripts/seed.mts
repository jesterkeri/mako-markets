#!/usr/bin/env tsx
/**
 * scripts/seed.ts — curated seed for MakoMarkets.
 *
 * Creates up to 6 long-lived markets (2 football, 2 crypto, up to 2 NBA)
 * on the live contract via a viem WalletClient. Runs locally only —
 * no HTTP endpoint, no auth surface.
 *
 * NBA entries are best-effort: if BALLDONTLIE_API_KEY is missing or no
 * upcoming games are returned (offseason), seed proceeds with the
 * football + crypto markets only.
 *
 * Usage:
 *   pnpm seed
 *
 * Requires these values in .env.local:
 *   ADMIN_PRIVATE_KEY=0x...     (deployer / resolver wallet)
 *   MAKO_ADDRESS=0x...          (deployed contract, non-zero)
 *   BALLDONTLIE_API_KEY=...     (optional — unlocks NBA markets)
 */
// dotenv's `/config` auto-loader only reads `.env`, not `.env.local`.
// Explicitly point it at `.env.local` (same file Next.js reads) so we
// don't maintain two env files.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import {
  createPublicClient,
  createWalletClient,
  http,
  stringToHex,
  pad,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Read the ABI directly from the Foundry compile output. This is the source
// of truth and avoids all the CJS/ESM cross-boundary import quirks we hit
// trying to import the generated `src/lib/MakoMarkets.abi.ts`.
const __dirname = dirname(fileURLToPath(import.meta.url));
const abiJson = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../mako-contracts/out/MakoMarketsV4.sol/MakoMarketsV4.json'),
    'utf-8',
  ),
) as { abi: readonly unknown[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makoAbi = abiJson.abi as any;
if (!Array.isArray(makoAbi) || makoAbi.length === 0) {
  console.error('[seed] FATAL: ABI not found or empty. Run `forge build` in ../mako-contracts/ first.');
  process.exit(1);
}

// ---------------------------------------------------------------
// Inlined from src/lib/oracle.ts to dodge the CJS/ESM cross-boundary
// import that breaks tsx when the script is .mts and the shared lib
// is .ts. Same logic, ~15 duplicated lines — pragmatic tradeoff.
// ---------------------------------------------------------------

const EMPTY_ORACLE_REF: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/** Encode a short UTF-8 string as bytes32, right-padded with zeros. */
function toBytes32(s: string): Hex {
  const hex = stringToHex(s);
  const byteLength = (hex.length - 2) / 2;
  if (byteLength > 32) {
    throw new Error(`oracleRef "${s}" is ${byteLength} bytes, max is 32`);
  }
  return pad(hex, { size: 32, dir: 'right' });
}

// ---------------------------------------------------------------
// MIRROR of src/lib/market-timing.ts — inlined to dodge tsx/ESM
// import boundary; see toBytes32 above for the same precedent. If
// the lib values change, update here too. Drift-check: the lib
// MUST hold PRE_EVENT_BUFFER_SEC=600, FOOTBALL_DURATION_SEC=9000,
// BASKETBALL_DURATION_SEC=10800, MAX_DURATION_SEC=604800,
// MIN_DURATION_SEC=300.
// ---------------------------------------------------------------
const PRE_EVENT_BUFFER_SEC = 10 * 60;
const FOOTBALL_DURATION_SEC = 150 * 60;
const BASKETBALL_DURATION_SEC = 180 * 60;
const MAX_DURATION_SEC = 7 * 24 * 60 * 60;
const MIN_DURATION_SEC = 5 * 60;

type SportsMarketType = 'football' | 'basketball';

function sportsTimestamps(
  eventStartSec: number,
  sport: SportsMarketType,
): { bettingCloseTime: bigint; closeTime: bigint } {
  const duration = sport === 'football' ? FOOTBALL_DURATION_SEC : BASKETBALL_DURATION_SEC;
  return {
    bettingCloseTime: BigInt(eventStartSec - PRE_EVENT_BUFFER_SEC),
    closeTime: BigInt(eventStartSec + duration),
  };
}

function suggestedCryptoBettingCloseTimeMirror(
  createdAtSec: number,
  resolutionTimeSec: number,
): bigint {
  if (resolutionTimeSec <= createdAtSec) return BigInt(createdAtSec);
  const duration = resolutionTimeSec - createdAtSec;
  let pctBps: number;
  if (duration <= 60 * 60) pctBps = 5000;
  else if (duration <= 24 * 60 * 60) pctBps = 6000;
  else if (duration <= 3 * 24 * 60 * 60) pctBps = 7000;
  else pctBps = 8500;
  return BigInt(createdAtSec + Math.floor((duration * pctBps) / 10000));
}

function assertTimestamps(
  nowSec: number,
  bettingCloseTime: bigint,
  closeTime: bigint,
  strict: boolean,
): void {
  const now = BigInt(nowSec);
  if (bettingCloseTime <= now) fail('bettingCloseTime must be in the future');
  if (closeTime <= now) fail('closeTime must be in the future');
  if (strict ? bettingCloseTime >= closeTime : bettingCloseTime > closeTime) {
    fail('bettingCloseTime must be on or before closeTime');
  }
  const durationSec = Number(closeTime - now);
  if (durationSec < MIN_DURATION_SEC) fail('event too soon (< MIN_DURATION)');
  if (durationSec > MAX_DURATION_SEC) fail('event too far out (> MAX_DURATION)');
}

// ---------------------------------------------------------------
// 1. Env validation — abort fast on any missing / malformed value
// ---------------------------------------------------------------

function fail(msg: string): never {
  console.error(`[seed] FATAL: ${msg}`);
  process.exit(1);
}

const RPC_URL = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz/';

const rawAddr = process.env.MAKO_ADDRESS;
if (!rawAddr) fail('MAKO_ADDRESS not set in .env.local');
if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddr)) fail(`MAKO_ADDRESS malformed: ${rawAddr}`);
if (rawAddr.toLowerCase() === '0x0000000000000000000000000000000000000000') {
  fail('MAKO_ADDRESS is the zero address — refusing to write to the null contract');
}
const MAKO_ADDRESS = rawAddr as Address;

const rawKey = process.env.ADMIN_PRIVATE_KEY;
if (!rawKey) fail('ADMIN_PRIVATE_KEY not set in .env.local');
if (!/^0x[a-fA-F0-9]{64}$/.test(rawKey)) {
  fail('ADMIN_PRIVATE_KEY malformed (expected 0x + 64 hex chars)');
}
const ADMIN_PRIVATE_KEY = rawKey as Hex;

// Optional — unlocks NBA seed entries. Missing key is not fatal: the NBA
// block below degrades to zero markets and logs a warning.
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY ?? '';

// ---------------------------------------------------------------
// 2. Clients
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

console.log(`[seed] deployer: ${account.address}`);
console.log(`[seed] contract: ${MAKO_ADDRESS}`);

// ---------------------------------------------------------------
// 3. Idempotency guard
// ---------------------------------------------------------------

// Cast to bigint because `makoAbi` is typed as `any` (the ABI is loaded from
// the Foundry JSON output at runtime, so wagmi's ABI type inference can't
// narrow the return type). Safe: nextMarketId() is declared `uint256` in
// the Solidity source and viem always decodes uint256 as bigint.
const existingCount = (await publicClient.readContract({
  address: MAKO_ADDRESS,
  abi: makoAbi,
  functionName: 'nextMarketId',
})) as bigint;

console.log(`[seed] nextMarketId currently: ${existingCount}`);

if (existingCount > 1n) {
  console.log(`[seed] already seeded (nextMarketId > 1) — skipping.`);
  console.log(`[seed] run the ad-hoc create form in the browser to add more markets.`);
  process.exit(0);
}

// ---------------------------------------------------------------
// 4. Live crypto prices for strike selection (CoinGecko, no auth)
// ---------------------------------------------------------------

async function fetchCryptoPrice(symbol: 'bitcoin' | 'ethereum'): Promise<number> {
  const fallback = symbol === 'bitcoin' ? 95000 : 3500;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`,
    );
    const data = (await res.json()) as Record<string, { usd: number }>;
    const p = data[symbol]?.usd;
    if (typeof p !== 'number' || p <= 0) return fallback;
    return p;
  } catch (e) {
    console.warn(`[seed] coingecko ${symbol} fetch failed, using fallback $${fallback}: ${e}`);
    return fallback;
  }
}

const [btcPrice, ethPrice] = await Promise.all([
  fetchCryptoPrice('bitcoin'),
  fetchCryptoPrice('ethereum'),
]);
console.log(`[seed] live prices: BTC $${btcPrice.toLocaleString()}, ETH $${ethPrice.toLocaleString()}`);

// ---------------------------------------------------------------
// 4b. Upcoming NBA games (balldontlie, auth via Authorization header)
// ---------------------------------------------------------------

interface UpcomingNbaGame {
  id: number;
  home: string;
  away: string;
  kickoff: Date;
}

async function fetchUpcomingNbaGames(limit: number): Promise<UpcomingNbaGame[]> {
  if (!BALLDONTLIE_API_KEY) {
    console.warn('[seed] BALLDONTLIE_API_KEY missing — skipping NBA markets');
    return [];
  }
  const now = Date.now();
  const start = new Date(now);
  const end = new Date(now + 7 * 24 * 3600 * 1000);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  const url = `https://api.balldontlie.io/v1/games?start_date=${startStr}&end_date=${endStr}&per_page=100`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: BALLDONTLIE_API_KEY, Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[seed] balldontlie upstream ${res.status} — skipping NBA markets`);
      return [];
    }
    const json = (await res.json()) as {
      data?: Array<{
        id: number;
        date: string;
        status?: string;
        home_team: { full_name: string };
        visitor_team: { full_name: string };
      }>;
    };
    // Keep only games that haven't tipped off yet (status is not already Final
    // and kickoff is > 10 minutes away — the same safety margin used for
    // closeTime below).
    return (json.data ?? [])
      .filter((g) => !g.status || !g.status.startsWith('Final'))
      .map((g) => ({
        id: g.id,
        home: g.home_team.full_name,
        away: g.visitor_team.full_name,
        kickoff: new Date(g.date),
      }))
      .filter((g) => g.kickoff.getTime() > now + 10 * 60 * 1000)
      .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime())
      .slice(0, limit);
  } catch (e) {
    console.warn(`[seed] balldontlie fetch failed, skipping NBA markets: ${e}`);
    return [];
  }
}

const nbaGames = await fetchUpcomingNbaGames(2);
if (nbaGames.length > 0) {
  console.log(
    `[seed] NBA upcoming (${nbaGames.length}): ${nbaGames
      .map((g) => `#${g.id} ${g.away}@${g.home} ${g.kickoff.toISOString()}`)
      .join('; ')}`,
  );
}

// ---------------------------------------------------------------
// 5. Market spec — 6 long-lived curated markets
// ---------------------------------------------------------------

enum MType {
  FOOTBALL = 0,
  CRYPTO = 1,
  BASKETBALL = 2,
}

const now = Math.floor(Date.now() / 1000);
const inHours = (h: number) => BigInt(now + Math.floor(h * 3600));

const btcStrike = Math.round(btcPrice * 1.01);
const ethStrike = Math.round(ethPrice * 0.99);

type MarketSpec = {
  mType: MType;
  oracleRef: Hex;
  bettingCloseTime: bigint;
  closeTime: bigint;
  question: string;
};

// Synthetic kickoff for the curated football fixtures (no real schedule
// data baked in). Use 3h from now as kickoff so the v4 timestamp split
// produces realistic bettingCloseTime / closeTime.
const fbKickoff = now + 3 * 3600;
const fb = sportsTimestamps(fbKickoff, 'football');

// Crypto curated: 2h evaluation horizon. bettingCloseTime mirrors the
// v4 contract's tier rule (≤1d window → 60% of duration).
const cryptoCloseTime = inHours(2);
const cryptoBettingClose = suggestedCryptoBettingCloseTimeMirror(now, Number(cryptoCloseTime));

const markets: MarketSpec[] = [
  {
    mType: MType.FOOTBALL,
    oracleRef: toBytes32('514237:home_win:0'),
    bettingCloseTime: fb.bettingCloseTime,
    closeTime: fb.closeTime,
    question: 'Will Arsenal beat Chelsea?',
  },
  {
    mType: MType.FOOTBALL,
    oracleRef: toBytes32('514238:over:2.5'),
    bettingCloseTime: fb.bettingCloseTime,
    closeTime: fb.closeTime,
    question: 'Over 2.5 goals in Man City vs Liverpool?',
  },
  {
    mType: MType.CRYPTO,
    oracleRef: toBytes32(`BTC:gt:${btcStrike}`),
    bettingCloseTime: cryptoBettingClose,
    closeTime: cryptoCloseTime,
    question: `Will BTC close above $${btcStrike.toLocaleString()} in 2 hours?`,
  },
  {
    mType: MType.CRYPTO,
    oracleRef: toBytes32(`ETH:gt:${ethStrike}`),
    bettingCloseTime: cryptoBettingClose,
    closeTime: cryptoCloseTime,
    question: `Will ETH close above $${ethStrike.toLocaleString()} in 2 hours?`,
  },
  // NBA: best-effort — appended only if balldontlie returned upcoming games.
  // bettingCloseTime is 10 min before tip-off; closeTime is tip-off + 3h.
  ...nbaGames.map((g): MarketSpec => {
    const tipoffSec = Math.floor(g.kickoff.getTime() / 1000);
    const ts = sportsTimestamps(tipoffSec, 'basketball');
    return {
      mType: MType.BASKETBALL,
      oracleRef: toBytes32(`${g.id}:home_win:0`),
      bettingCloseTime: ts.bettingCloseTime,
      closeTime: ts.closeTime,
      question: `Will the ${g.home} beat the ${g.away}?`,
    };
  }),
];

// ---------------------------------------------------------------
// 6. Create each market, wait for receipt, log id + hash
// ---------------------------------------------------------------

let nextId = Number(existingCount);
console.log(`[seed] creating ${markets.length} markets...`);
console.log('');

for (const m of markets) {
  console.log(`[seed] [${nextId}] "${m.question}"`);
  // Validate before signing — burning gas on a known-revert tx is just
  // bad ergonomics during seed iteration.
  assertTimestamps(now, m.bettingCloseTime, m.closeTime, m.mType !== MType.CRYPTO);
  const hash = await walletClient.writeContract({
    address: MAKO_ADDRESS,
    abi: makoAbi,
    functionName: 'createMarket',
    args: [m.mType, m.oracleRef, m.bettingCloseTime, m.closeTime, m.question],
  });
  console.log(`[seed]        tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    fail(`createMarket reverted — tx ${hash}, block ${receipt.blockNumber}`);
  }
  console.log(`[seed]        block ${receipt.blockNumber}, gas ${receipt.gasUsed}, OK`);
  console.log('');

  nextId++;
}

console.log(`[seed] done. nextMarketId is now ${nextId}.`);
console.log(`[seed] verify on MonadVision:`);
console.log(`[seed]   https://testnet.monadvision.xyz/address/${MAKO_ADDRESS}`);
console.log(`[seed] reload http://localhost:3002/ to see the new markets in the feed.`);
