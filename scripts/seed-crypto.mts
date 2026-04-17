#!/usr/bin/env tsx
/**
 * scripts/seed-crypto.mts — additive crypto seed.
 *
 * Fetches live BTC/ETH/SOL/MON spot prices from CoinGecko and creates N
 * crypto markets on-chain with strikes offset from spot. Each market
 * asks "Will <SYMBOL> close above/below $<strike> in <N> hours?" and
 * resolves against CoinGecko at closeTime via the auto-resolver.
 *
 * Why no dedup: unlike football/NBA markets which are keyed off an
 * external event ID (matchId / gameId), crypto markets are keyed off
 * (symbol, strike, closeTime). Each run creates fresh strikes at a
 * fresh closeTime — by definition non-duplicate. Still safe to re-run:
 * the worst it does is crowd the feed with similar questions.
 *
 * Why fetch not curl: CoinGecko's TLS plays nice with Node 25 (seed.mts
 * already calls it via fetch and works). Only balldontlie + possibly
 * football-data.org have the host-specific TLS hang.
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-crypto.mts            # BTC + ETH (2)
 *   LIMIT=3  pnpm exec tsx scripts/seed-crypto.mts   # BTC + ETH + SOL
 *   LIMIT=5  pnpm exec tsx scripts/seed-crypto.mts   # + AVAX + NEAR
 *   LIMIT=10 pnpm exec tsx scripts/seed-crypto.mts   # full registry
 *   DURATION_HOURS=6 ... to change market window (default 2h)
 *
 * MIRROR_CRYPTO_ASSETS: PRICE_ROWS below must match src/lib/crypto-assets.ts
 * and scripts/auto-resolver.mts's CRYPTO_SYMBOLS. tsx can't import from src/
 * cleanly so we inline-duplicate.
 *
 * Requires in .env.local:
 *   ADMIN_PRIVATE_KEY=0x...
 *   MAKO_ADDRESS=0x...
 */
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

function fail(msg: string): never {
  console.error(`[seed-crypto] FATAL: ${msg}`);
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

const LIMIT = Math.max(1, Math.min(10, Number(process.env.LIMIT ?? '2')));
const DURATION_HOURS = Math.max(1, Math.min(168, Number(process.env.DURATION_HOURS ?? '2')));

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

console.log(`[seed-crypto] deployer: ${account.address}`);
console.log(`[seed-crypto] contract: ${MAKO_ADDRESS}`);
console.log(`[seed-crypto] limit: ${LIMIT} · duration: ${DURATION_HOURS}h`);

const MarketType = { FOOTBALL: 0, CRYPTO: 1, BASKETBALL: 2 } as const;

function toBytes32(s: string): Hex {
  const hex = stringToHex(s);
  const byteLength = (hex.length - 2) / 2;
  if (byteLength > 32) throw new Error(`oracleRef "${s}" is ${byteLength} bytes, max 32`);
  return pad(hex, { size: 32, dir: 'right' });
}

// ---------------------------------------------------------------
// Fetch live prices from CoinGecko (Node fetch works for this host)
// ---------------------------------------------------------------

interface PriceRow {
  symbol: string;
  coingeckoId: string;
  // Per-symbol offset: % added to spot for the "gt" strike. Chose asymmetric
  // offsets so the markets feel distinct — tight for majors, wider for
  // high-volatility assets. Tune freely, these are UX choices, not correctness.
  gtOffsetPct: number;
}

const PRICE_ROWS: PriceRow[] = [
  { symbol: 'BTC',  coingeckoId: 'bitcoin',      gtOffsetPct: 1.0 },
  { symbol: 'ETH',  coingeckoId: 'ethereum',     gtOffsetPct: 1.5 },
  { symbol: 'SOL',  coingeckoId: 'solana',       gtOffsetPct: 2.0 },
  { symbol: 'AVAX', coingeckoId: 'avalanche-2',  gtOffsetPct: 2.5 },
  { symbol: 'NEAR', coingeckoId: 'near',         gtOffsetPct: 3.0 },
  { symbol: 'APT',  coingeckoId: 'aptos',        gtOffsetPct: 3.0 },
  { symbol: 'SUI',  coingeckoId: 'sui',          gtOffsetPct: 3.0 },
  { symbol: 'DOGE', coingeckoId: 'dogecoin',     gtOffsetPct: 4.0 },
  { symbol: 'LINK', coingeckoId: 'chainlink',    gtOffsetPct: 2.5 },
  { symbol: 'MON',  coingeckoId: 'monad',        gtOffsetPct: 2.0 },
];

const picked = PRICE_ROWS.slice(0, LIMIT);
const ids = picked.map((p) => p.coingeckoId).join(',');
const priceUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;

console.log(`[seed-crypto] fetching ${picked.map((p) => p.symbol).join(', ')} from CoinGecko...`);

type PriceMap = Record<string, { usd: number }>;
let priceMap: PriceMap;
try {
  const res = await fetch(priceUrl);
  if (!res.ok) fail(`coingecko ${res.status}`);
  priceMap = (await res.json()) as PriceMap;
} catch (e) {
  fail(`coingecko fetch failed: ${(e as Error).message}`);
}

// Validate we got every price we asked for.
for (const p of picked) {
  const usd = priceMap[p.coingeckoId]?.usd;
  if (typeof usd !== 'number' || usd <= 0) {
    fail(`coingecko returned no price for ${p.coingeckoId} — refusing to seed bad data`);
  }
}

// ---------------------------------------------------------------
// Build specs, then create each market
// ---------------------------------------------------------------

const now = Math.floor(Date.now() / 1000);
const closeTime = BigInt(now + DURATION_HOURS * 3600);

interface Spec {
  symbol: string;
  strike: number;
  question: string;
  oracleRef: Hex;
}
/**
 * Round a strike price with precision that matches the asset's scale.
 * Integer rounding on a sub-dollar asset like DOGE ($0.10) collapses to
 * $0 — which trivializes the market AND hits the resolver's `strike <= 0`
 * reject branch, stranding the market until forceRefund. Keep ≥ 2 sig-figs.
 */
function roundStrike(spot: number): number {
  if (spot >= 100) return Math.round(spot); // $100+: dollar precision
  if (spot >= 10) return Math.round(spot * 10) / 10; // $10+: 1 decimal
  if (spot >= 1) return Math.round(spot * 100) / 100; // $1+: 2 decimals
  if (spot >= 0.1) return Math.round(spot * 1000) / 1000; // $0.10+: 3 decimals
  if (spot >= 0.01) return Math.round(spot * 10_000) / 10_000; // $0.01+: 4
  return Math.round(spot * 1_000_000) / 1_000_000; // sub-cent: 6 decimals
}

function formatStrikeForDisplay(strike: number): string {
  if (strike >= 1) return strike.toLocaleString();
  return strike.toString();
}

const specs: Spec[] = picked.map((p) => {
  const spot = priceMap[p.coingeckoId].usd;
  const strike = roundStrike(spot * (1 + p.gtOffsetPct / 100));
  if (strike <= 0) {
    fail(`computed strike=${strike} for ${p.symbol} (spot=${spot}) — refusing to seed`);
  }
  return {
    symbol: p.symbol,
    strike,
    question: `Will ${p.symbol} close above $${formatStrikeForDisplay(strike)} in ${DURATION_HOURS} hours?`,
    oracleRef: toBytes32(`${p.symbol}:gt:${strike}`),
  };
});

console.log(`[seed-crypto] live strikes:`);
for (const s of specs) console.log(`  ${s.symbol}  strike=$${s.strike.toLocaleString()}`);
console.log('');

const nextId = (await publicClient.readContract({
  address: MAKO_ADDRESS,
  abi: makoAbi,
  functionName: 'nextMarketId',
})) as bigint;
console.log(`[seed-crypto] nextMarketId: ${nextId}`);

let placedAt = Number(nextId);
for (const s of specs) {
  if (s.question.length > 200) fail(`question exceeds 200 chars: "${s.question}"`);

  console.log(`[seed-crypto] [${placedAt}] "${s.question}"`);
  const hash = await walletClient.writeContract({
    address: MAKO_ADDRESS,
    abi: makoAbi,
    functionName: 'createMarket',
    args: [MarketType.CRYPTO, s.oracleRef, closeTime, s.question],
  });
  console.log(`[seed-crypto]        tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    fail(`createMarket reverted — tx ${hash}, block ${receipt.blockNumber}`);
  }
  console.log(`[seed-crypto]        block ${receipt.blockNumber}, gas ${receipt.gasUsed}, OK`);
  console.log('');
  placedAt++;
}

console.log(`[seed-crypto] done. nextMarketId is now ${placedAt}.`);
console.log(`[seed-crypto]   https://testnet.monadvision.xyz/address/${MAKO_ADDRESS}`);
