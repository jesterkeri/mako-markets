// Read-only live check of src/market-reads.ts against Monad testnet: every market through Multicall3 at one finalized
// block, compared field by field with a direct getMarket of a sample at the same block. Prints counts only.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
const raws: string[] = [];
const base = httpRpc(RPC);
const post = async (body: string) => { const r = await base(body); raws.push(r.text); return r; };
const out = await readMarkets<{ closeTime: bigint }>({ post, mako: MAKO, marketAbi: makoAbi, ids, block: block.number, capExceeded });
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
const evidence = { at: new Date().toISOString(), command: 'npx tsx cf-worker/scripts/live-market-reads.ts <outDir>', rpc: RPC, block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() }, markets: count.toString(), read: ok.length, failed, requests: out.requests, responseBytes: out.bytes, responseSha256: raws.map((t) => createHash('sha256').update(t).digest('hex')), wallMs: ms, sampleIdsComparedWithDirectGetMarket: [0, 1, 50, 105, Number(count) - 1], sampleMismatches: mismatches };
const dir = process.argv[2];
if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'live-reads.json'), JSON.stringify(evidence, null, 2)); }
console.log(JSON.stringify(evidence));
}
main().catch((e) => { console.error(e?.name ?? 'error'); process.exit(1); });
