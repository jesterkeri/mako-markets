// Read-only evidence for the Data Streams verification provider pair (RESOLVER_PRICE_PLAN §4.3, review r15 finding 3).
// For each candidate: network identity (resolved IPv4, ASN owner, TLS certificate), chain id, the hash of one common
// finalized block, `VerifierProxy.verify` of a REAL captured report at that block (raw bytes + sha256), the same call
// at an older block (archive support), and a short burst to observe rate limiting. No keys are used; nothing is sent.
//
//   npx tsx scripts/verify-provider-probe.ts <outDir>
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { join } from 'node:path';
import { encodeFunctionData } from 'viem';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/fixture-btcusd-1789529160.json', 'file://' + __filename), 'utf8'));
const VERIFIER = '0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64';
const abi = [{ type: 'function', name: 'verify', stateMutability: 'payable', inputs: [{ name: 'p', type: 'bytes' }, { name: 'q', type: 'bytes' }], outputs: [{ name: '', type: 'bytes' }] }] as const;
const data = encodeFunctionData({ abi, functionName: 'verify', args: [fx.fullReport, '0x'] });
const PROVIDERS = [
  { role: 'required', url: 'https://testnet-rpc.monad.xyz' },
  { role: 'required', url: 'https://rpc.ankr.com/monad_testnet' },
  { role: 'fallback', url: 'https://10143.rpc.thirdweb.com' },
  { role: 'rejected-not-independent', url: 'https://rpc-testnet.monadinfra.com' },
];
/// About 7 days of 0.302 s blocks: an archive read well inside the fixture's validity window is not needed (verify
/// ignores expiry); this only tests that the provider serves state older than its recent cache.
const OLDER_BLOCKS = 2_000_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function rpc(url: string, method: string, params: unknown[]) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown } } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { http: r.status, ms: Date.now() - t0, body, raw: body ? null : text.slice(0, 200) };
  } catch (e) {
    return { http: 0, ms: Date.now() - t0, body: null, raw: (e as Error).name };
  }
}

function tlsCert(host: string): Promise<{ subject: string; issuer: string; validTo: string } | { error: string }> {
  return new Promise((resolve) => {
    const s = connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const c = s.getPeerCertificate();
      resolve({ subject: c.subject?.CN ?? '', issuer: `${c.issuer?.O ?? ''} ${c.issuer?.CN ?? ''}`.trim(), validTo: c.valid_to });
      s.end();
    });
    s.on('error', (e) => resolve({ error: e.name }));
    s.on('timeout', () => {
      resolve({ error: 'timeout' });
      s.destroy();
    });
  });
}

async function asn(ip: string): Promise<string> {
  try {
    return (await (await fetch(`https://ipinfo.io/${ip}/org`, { signal: AbortSignal.timeout(10000) })).text()).trim();
  } catch {
    return 'lookup failed';
  }
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: verify-provider-probe.ts <outDir>');
  mkdirSync(outDir, { recursive: true });
  const at = new Date().toISOString();
  const fin = await rpc(PROVIDERS[0].url, 'eth_getBlockByNumber', ['finalized', false]);
  const finBlock = fin.body?.result as { number: string; hash: string; timestamp: string };
  const older = `0x${(parseInt(finBlock.number, 16) - OLDER_BLOCKS).toString(16)}`;
  const report: Record<string, unknown> = {
    probedAt: at,
    command: 'npx tsx cf-worker/scripts/verify-provider-probe.ts <outDir>',
    report: { feedID: fx.feedID, observationsTimestamp: fx.observationsTimestamp, fullReportSha256: sha(fx.fullReport), source: 'cf-worker/test/fixtures/fixture-btcusd-1789529160.json' },
    commonBlock: { number: parseInt(finBlock.number, 16), hash: finBlock.hash, timestamp: parseInt(finBlock.timestamp, 16) },
    olderBlock: parseInt(older, 16),
    providers: [] as unknown[],
  };
  for (const p of PROVIDERS) {
    const host = new URL(p.url).hostname;
    const ips = await dns.resolve4(host).catch(() => [] as string[]);
    const chain = await rpc(p.url, 'eth_chainId', []);
    const own = await rpc(p.url, 'eth_getBlockByNumber', ['finalized', false]);
    const same = await rpc(p.url, 'eth_getBlockByNumber', [finBlock.number, false]);
    const v = await rpc(p.url, 'eth_call', [{ to: VERIFIER, data }, finBlock.number]);
    const vOld = await rpc(p.url, 'eth_call', [{ to: VERIFIER, data }, older]);
    const burst = await Promise.all(Array.from({ length: 20 }, () => rpc(p.url, 'eth_blockNumber', [])));
    const result = typeof v.body?.result === 'string' ? (v.body.result as string) : null;
    const resultOld = typeof vOld.body?.result === 'string' ? (vOld.body.result as string) : null;
    report.providers = [
      ...(report.providers as unknown[]),
      {
        role: p.role,
        host,
        ipv4: ips,
        asn: await Promise.all(ips.slice(0, 2).map(asn)),
        tls: await tlsCert(host),
        chainId: typeof chain.body?.result === 'string' ? parseInt(chain.body.result as string, 16) : null,
        ownFinalized: own.body?.result ? parseInt((own.body.result as { number: string }).number, 16) : own.body?.error ?? own.raw,
        commonBlockHashMatches: (same.body?.result as { hash?: string } | undefined)?.hash === finBlock.hash,
        verifyAtCommonBlock: result ? { bytes: (result.length - 2) / 2, sha256: sha(result), raw: result, ms: v.ms } : { error: v.body?.error ?? v.raw, http: v.http },
        verifyAtOlderBlock: resultOld ? { bytes: (resultOld.length - 2) / 2, sha256: sha(resultOld) } : { error: vOld.body?.error ?? vOld.raw, http: vOld.http },
        burst20: {
          ok: burst.filter((b) => typeof b.body?.result === 'string').length,
          http429: burst.filter((b) => b.http === 429).length,
          rpcErrors: [...new Set(burst.map((b) => (b.body?.error ? String(b.body.error.code) : null)).filter(Boolean))],
          maxMs: Math.max(...burst.map((b) => b.ms)),
        },
      },
    ];
  }
  const file = join(outDir, 'providers.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  for (const p of report.providers as { role: string; host: string; asn: string[]; commonBlockHashMatches: boolean; verifyAtCommonBlock: { sha256?: string }; verifyAtOlderBlock: { sha256?: string; error?: unknown }; burst20: unknown }[]) {
    console.log(p.role.padEnd(26), p.host.padEnd(28), p.asn[0] ?? '', '| hash', p.commonBlockHashMatches, '| verify', p.verifyAtCommonBlock.sha256?.slice(0, 16) ?? 'ERR', '| older', p.verifyAtOlderBlock.sha256?.slice(0, 16) ?? JSON.stringify(p.verifyAtOlderBlock.error).slice(0, 40), '| burst', JSON.stringify(p.burst20));
  }
  console.log('wrote', file, 'sha256', sha(readFileSync(file, 'utf8')));
}
main().catch((e) => {
  console.error(e?.name ?? 'error');
  process.exit(1);
});
