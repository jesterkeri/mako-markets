// scripts/probe-pyth-onchain.mts
//
// Read-only smoke probe for #180 Pyth feeds. Hits the live Monad
// testnet contract via the public RPC, reads every market, and
// reports:
//   - mType distribution (are there any FOREX/COMMODITIES/STOCKS?)
//   - For each price-feed market: oracleRef + whether it would parse
//     under the new allowlist
//
// No secrets, no writes. Hardcoded public RPC + public contract
// address; safe to run anywhere.
//
// Usage:
//   pnpm tsx scripts/probe-pyth-onchain.mts
//
// Recommended cadence: run before AND after the v4 redeploy (#170)
// to confirm (a) no pre-existing price-feed markets carry stale
// oracleRefs the new allowlist would reject, and (b) the redeployed
// contract supports the expanded MarketType enum.

import { createPublicClient, http, hexToString } from 'viem';
import abiJson from '../cf-worker/src/mako-abi.json';
import { PRICE_FEED_BY_SYMBOL } from '../src/lib/price-feed-assets.js';

const MAKO_ADDRESS = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const monad = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz/'] },
    public: { http: ['https://testnet-rpc.monad.xyz/'] },
  },
};
const abi = Array.isArray(abiJson) ? abiJson : abiJson.abi;
const client = createPublicClient({ chain: monad, transport: http() });

const MTYPE_LABEL: Record<string, string> = {
  '0': 'FOOTBALL',
  '1': 'CRYPTO',
  '2': 'BASKETBALL',
  '3': 'FOREX',
  '4': 'COMMODITIES',
  '5': 'STOCKS',
  '6': 'MAKO',
};

const count = Number(await client.readContract({
  address: MAKO_ADDRESS,
  abi,
  functionName: 'nextMarketId',
}));
console.log(`nextMarketId: ${count}`);

// Minimal shape of the v4 Market struct we touch here. Used as a
// type assertion on the `unknown` return of `readContract` because
// the abi handle in this script is JSON-loaded (not a `const`-typed
// viem ABI), so viem can't infer the return shape.
type MarketRead = {
  mType: number | bigint;
  oracleRef: `0x${string}`;
  resolved: boolean;
  outcome: number | bigint;
  closeTime: bigint;
  question: string;
};

type PriceFeedMarket = {
  id: number;
  mType: number;
  oracleRef: `0x${string}`;
  resolved: boolean;
  outcome: number;
  closeTime: number;
  question: string;
};

const dist: Record<number, number> = {};
const priceFeedMarkets: PriceFeedMarket[] = [];

for (let i = 0; i < count; i++) {
  try {
    const m = (await client.readContract({
      address: MAKO_ADDRESS,
      abi,
      functionName: 'getMarket',
      args: [BigInt(i)],
    })) as MarketRead;
    const mType = Number(m.mType);
    dist[mType] = (dist[mType] || 0) + 1;
    if (mType >= 3 && mType <= 5) {
      priceFeedMarkets.push({
        id: i,
        mType,
        oracleRef: m.oracleRef,
        resolved: m.resolved,
        outcome: Number(m.outcome),
        closeTime: Number(m.closeTime),
        question: m.question,
      });
    }
  } catch (e: unknown) {
    const err = e as { shortMessage?: string; message?: string };
    console.warn(`market ${i}: read failed: ${err.shortMessage ?? err.message ?? String(e)}`);
  }
}

console.log('\n=== mType distribution ===');
for (const [k, v] of Object.entries(dist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  mType=${k} (${MTYPE_LABEL[k] || '?'}): ${v}`);
}

console.log(`\n=== price-feed markets (mType 3/4/5): ${priceFeedMarkets.length} ===`);
if (priceFeedMarkets.length === 0) {
  console.log('  none — no FOREX/COMMODITIES/STOCKS markets exist on chain yet');
  console.log('  → live contract is likely v3 (no support for new types) or v4-fresh with no usage');
} else {
  const expectedClassFor = (mt: number): 'forex' | 'commodities' | 'stocks' =>
    mt === 3 ? 'forex' : mt === 4 ? 'commodities' : 'stocks';
  for (const m of priceFeedMarkets) {
    let decoded = '';
    try { decoded = hexToString(m.oracleRef, { size: 32 }).replace(/\0+$/, '').trim(); } catch { decoded = '(decode failed)'; }
    const parts = decoded.split(':');
    let parseStatus = 'unknown';
    if (parts.length !== 3) {
      parseStatus = 'BAD_FORMAT (wrong part count)';
    } else {
      const [sym, op, strike] = parts.map(p => p.trim());
      const asset = PRICE_FEED_BY_SYMBOL.get(sym);
      if (!asset) parseStatus = `UNKNOWN_SYMBOL (${sym})`;
      else if (asset.class !== expectedClassFor(m.mType)) parseStatus = `CLASS_MISMATCH (${sym} is ${asset.class}, mType expects ${expectedClassFor(m.mType)})`;
      else if (op !== 'gt' && op !== 'lt') parseStatus = `BAD_FORMAT (op=${op})`;
      else if (!/^\+?(\d+\.\d+|\d+|\.\d+)$/.test(strike) || Number(strike) <= 0) parseStatus = `BAD_FORMAT (strike=${strike})`;
      else parseStatus = `OK (${sym} ${op} ${strike})`;
    }
    console.log(`  market ${m.id} mType=${m.mType} resolved=${m.resolved}`);
    console.log(`    oracleRef decoded: "${decoded}"`);
    console.log(`    parse: ${parseStatus}`);
    console.log(`    closeTime: ${new Date(m.closeTime * 1000).toISOString()}`);
  }
}

console.log('\n=== contract version inference ===');
const hasV4Types = Object.keys(dist).some(k => Number(k) >= 3);
if (hasV4Types) {
  console.log('  v4 contract LIVE — supports FOREX/COMMODITIES/STOCKS/MAKO mTypes');
} else {
  console.log('  v3 contract (or v4 with no usage of new types yet) — only mTypes 0/1/2 observed');
  console.log('  reminder per memory: v4 redeploy is mid-flight, deploy NOT yet executed');
  console.log('  --> creating mType 3/4/5 markets via /create today would REVERT on chain');
}
