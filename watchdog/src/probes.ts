// The watchdog's own probes (r4 §5.4). Each returns an observation; flap
// control in classify.ts decides when a check changes state.

import { CHAIN_ID, PROBE_CHART_SYMBOL, PROBE_MARKET_ID, PROBE_MARKET_TITLE, RR_MAX_LAG_BLOCKS } from './config';
import { send, type Net } from './net';
import { hexQuantity, rpcBatch } from './rpc';
import type { DiscoveryResult } from './scan';
import type { Obs } from './classify';

export interface ProbeResult {
  code: string;
  obs: Obs;
  detail: string;
}

/// Which probes are due at this run's minute (r4 §5.4): pb and rr every run,
/// comments at minutes 0 and 30, the market page and charts at minute 0.
export function dueProbes(scheduledTime: number): { nc: boolean; mp: boolean; ch: boolean } {
  const minute = new Date(scheduledTime).getUTCMinutes();
  return { nc: minute === 0 || minute === 30, mp: minute === 0, ch: minute === 0 };
}

/// pb: provider B answers, on chain 10143, and its latest block has advanced
/// since the last committed run.
export function probeProviderB(d: DiscoveryResult, lastLatestBlock: number | null): ProbeResult {
  if (!d.ok) return { code: 'pb', obs: 'fail', detail: `provider B: ${d.reason}` };
  const v = d.value;
  if (v.chainId !== CHAIN_ID) return { code: 'pb', obs: 'fail', detail: `provider B: chain id ${v.chainId}` };
  if (v.finalizedBlock > v.latestBlock) return { code: 'pb', obs: 'fail', detail: 'provider B: finalized block ahead of latest' };
  if (lastLatestBlock !== null && v.latestBlock <= lastLatestBlock) {
    return { code: 'pb', obs: 'fail', detail: `provider B: block not advancing (${v.latestBlock})` };
  }
  return { code: 'pb', obs: 'ok', detail: '' };
}

export interface PublicRpc {
  ok: boolean;
  chainId: number | null;
  latestBlock: number | null;
  reason: string;
}

export async function readPublicRpc(net: Net, url: string): Promise<PublicRpc> {
  const b = await rpcBatch(net, url, [
    { method: 'eth_chainId', params: [] },
    { method: 'eth_blockNumber', params: [] },
  ]);
  if (!b.ok) return { ok: false, chainId: null, latestBlock: null, reason: b.kind };
  const [c, n] = b.items;
  const chainId = c.ok ? hexQuantity(c.result) : null;
  const latest = n.ok ? hexQuantity(n.result) : null;
  if (chainId === null || latest === null) return { ok: false, chainId: null, latestBlock: null, reason: 'call_failed' };
  return { ok: true, chainId: Number(chainId), latestBlock: Number(latest), reason: '' };
}

/// rr: the resolver's RPC answers on chain 10143 and is within 30 blocks of
/// provider B's latest block.
export function probeResolverRpc(p: PublicRpc, providerLatest: number | null): ProbeResult {
  if (!p.ok) return { code: 'rr', obs: 'fail', detail: `resolver RPC: ${p.reason}` };
  if (p.chainId !== CHAIN_ID) return { code: 'rr', obs: 'fail', detail: `resolver RPC: chain id ${p.chainId}` };
  if (providerLatest !== null && p.latestBlock !== null && providerLatest - p.latestBlock > RR_MAX_LAG_BLOCKS) {
    return { code: 'rr', obs: 'fail', detail: `resolver RPC: ${providerLatest - p.latestBlock} blocks behind provider B` };
  }
  return { code: 'rr', obs: 'ok', detail: '' };
}

/// nc: a real database read through the comments API (catches Neon down or
/// out of quota, as on 2026-07-20).
export async function probeComments(net: Net, appUrl: string): Promise<ProbeResult> {
  const r = await send(net, `${appUrl}/api/comments?scope=main&marketId=${PROBE_MARKET_ID}&limit=1`, { method: 'GET' });
  if (!r.ok) return { code: 'nc', obs: 'fail', detail: `comments API: ${r.kind}${r.status ? ' ' + r.status : ''}` };
  try {
    const body = JSON.parse(r.text) as { comments?: unknown; nextCursor?: unknown };
    if (Array.isArray(body.comments) && 'nextCursor' in body) return { code: 'nc', obs: 'ok', detail: '' };
  } catch {
    // fall through
  }
  return { code: 'nc', obs: 'fail', detail: 'comments API: unexpected body' };
}

/// mp: the market page renders the market's own title (frontend env, its
/// server RPC and the contract, as broken on 2026-05-24 and 2026-07-07).
export async function probeMarketPage(net: Net, appUrl: string): Promise<ProbeResult> {
  const r = await send(net, `${appUrl}/market/${PROBE_MARKET_ID}`, { method: 'GET' });
  if (!r.ok) return { code: 'mp', obs: 'fail', detail: `market page: ${r.kind}${r.status ? ' ' + r.status : ''}` };
  return r.text.includes(PROBE_MARKET_TITLE)
    ? { code: 'mp', obs: 'ok', detail: '' }
    : { code: 'mp', obs: 'fail', detail: 'market page: title missing' };
}

/// ch: the charts API returns candles for a crypto symbol.
export async function probeCharts(net: Net, appUrl: string): Promise<ProbeResult> {
  const r = await send(net, `${appUrl}/api/charts?s=${PROBE_CHART_SYMBOL}`, { method: 'GET' });
  if (!r.ok) return { code: 'ch', obs: 'fail', detail: `charts API: ${r.kind}${r.status ? ' ' + r.status : ''}` };
  try {
    const body = JSON.parse(r.text) as { candles?: unknown };
    if (Array.isArray(body.candles) && body.candles.length > 0) return { code: 'ch', obs: 'ok', detail: '' };
  } catch {
    // fall through
  }
  return { code: 'ch', obs: 'fail', detail: 'charts API: no candles' };
}
