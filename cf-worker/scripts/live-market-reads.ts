// Read-only live check of src/market-reads.ts against Monad testnet: every market through Multicall3 at one finalized
// block, compared field by field with a direct getMarket of a sample at the same block. Prints counts only.
import { createPublicClient, http, type Address } from 'viem';
import { makoAbi } from '../src/abi';
import { httpRpc, idsToRead, readMarkets } from '../src/market-reads';

const RPC = 'https://testnet-rpc.monad.xyz';
const MAKO = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195' as Address;
async function main() {
const client = createPublicClient({ transport: http(RPC) });
const block = await client.getBlock({ blockTag: 'finalized' });
const count = (await client.readContract({ address: MAKO, abi: makoAbi as never, functionName: 'nextMarketId' as never, blockNumber: block.number })) as bigint;
const { ids, capExceeded } = idsToRead(count);
const t0 = Date.now();
const out = await readMarkets<{ closeTime: bigint }>({ post: httpRpc(RPC), mako: MAKO, marketAbi: makoAbi, ids, block: block.number, capExceeded });
const ms = Date.now() - t0;
const ok = out.reads.filter((r) => r.ok);
const failed = out.reads.filter((r) => !r.ok).map((r) => `${r.id}:${(r as { reason: string }).reason}`);
let mismatches = 0;
for (const id of [0n, 1n, 50n, 105n, count - 1n].filter((x) => x < count)) {
  const direct = await client.readContract({ address: MAKO, abi: makoAbi as never, functionName: 'getMarket' as never, args: [id] as never, blockNumber: block.number });
  const viaMc = out.reads.find((r) => r.id === id);
  const a = JSON.stringify(direct, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  const b = viaMc && viaMc.ok ? JSON.stringify(viaMc.market, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) : 'FAILED';
  if (a !== b) mismatches++;
}
console.log(JSON.stringify({ block: block.number.toString(), markets: count.toString(), read: ok.length, failed, requests: out.requests, bytes: out.bytes, ms, sampleMismatches: mismatches }));
}
main().catch((e) => { console.error(e?.name ?? 'error'); process.exit(1); });
