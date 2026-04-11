#!/usr/bin/env tsx
/**
 * scripts/seed.ts — curated seed for MakoMarkets.
 *
 * Creates 6 long-lived markets (2 football, 2 crypto, 2 adhoc) on the live
 * contract via a viem WalletClient. Runs locally only — no HTTP endpoint,
 * no auth surface.
 *
 * Usage:
 *   pnpm seed
 *
 * Requires these values in .env.local:
 *   ADMIN_PRIVATE_KEY=0x...    (deployer / resolver wallet)
 *   MAKO_ADDRESS=0x87129a...   (deployed contract, non-zero)
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
    resolve(__dirname, '../../mako-contracts/out/MakoMarkets.sol/MakoMarkets.json'),
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
// 5. Market spec — 6 long-lived curated markets
// ---------------------------------------------------------------

enum MType {
  FOOTBALL = 0,
  CRYPTO = 1,
  ADHOC = 2,
}

const now = Math.floor(Date.now() / 1000);
const inHours = (h: number) => BigInt(now + Math.floor(h * 3600));

const btcStrike = Math.round(btcPrice * 1.01);
const ethStrike = Math.round(ethPrice * 0.99);

type MarketSpec = {
  mType: MType;
  oracleRef: Hex;
  closeTime: bigint;
  question: string;
};

const markets: MarketSpec[] = [
  {
    mType: MType.FOOTBALL,
    oracleRef: toBytes32('514237:home_win:0'),
    closeTime: inHours(3),
    question: 'Will Arsenal beat Chelsea?',
  },
  {
    mType: MType.FOOTBALL,
    oracleRef: toBytes32('514238:over:2.5'),
    closeTime: inHours(3),
    question: 'Over 2.5 goals in Man City vs Liverpool?',
  },
  {
    mType: MType.CRYPTO,
    oracleRef: toBytes32(`BTC:gt:${btcStrike}`),
    closeTime: inHours(2),
    question: `Will BTC close above $${btcStrike.toLocaleString()} in 2 hours?`,
  },
  {
    mType: MType.CRYPTO,
    oracleRef: toBytes32(`ETH:gt:${ethStrike}`),
    closeTime: inHours(2),
    question: `Will ETH close above $${ethStrike.toLocaleString()} in 2 hours?`,
  },
  // ADHOC seed markets retired — product surface only supports structured
  // (auto-resolvable) market types going forward. Contract still supports ADHOC
  // if a future build ever wants to re-enable them.
];

// ---------------------------------------------------------------
// 6. Create each market, wait for receipt, log id + hash
// ---------------------------------------------------------------

let nextId = Number(existingCount);
console.log(`[seed] creating ${markets.length} markets...`);
console.log('');

for (const m of markets) {
  console.log(`[seed] [${nextId}] "${m.question}"`);
  const hash = await walletClient.writeContract({
    address: MAKO_ADDRESS,
    abi: makoAbi,
    functionName: 'createMarket',
    args: [m.mType, m.oracleRef, m.closeTime, m.question],
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
