// A local anvil node in Monad mode, started on a free port, and what it takes to skip politely when the tools
// are not there. Nothing here touches the network beyond 127.0.0.1.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PKG = resolve(here, '..');

export function findContracts(): string | null {
  const candidates = [
    process.env.MAKO_CONTRACTS_DIR,
    join(PKG, '..', '..', '..', '..', '..', 'mako-contracts', '.claude', 'worktrees', 'outcome-exchange'),
    join(PKG, '..', '..', 'mako-contracts', '.claude', 'worktrees', 'outcome-exchange'),
  ].filter((c): c is string => !!c);
  return candidates.map((c) => resolve(c)).find((c) => existsSync(join(c, 'out', 'MakoOutcomeExchangeV1.sol', 'MakoOutcomeExchangeV1.json'))) ?? null;
}

export function recordedCommit(): string {
  return (JSON.parse(readFileSync(join(PKG, 'data', 'VENDORED_FROM.json'), 'utf8')) as { commit: string }).commit;
}

/// Why the integration test cannot run, or null when it can.
export function skipReason(): string | null {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0) return 'anvil is not installed (foundry)';
  const help = spawnSync('anvil', ['--help'], { encoding: 'utf8' }).stdout;
  if (!/monad/.test(help)) return 'this anvil has no `--network monad`';
  const dir = findContracts();
  if (!dir) return 'no mako-contracts checkout with a built out/ directory (set MAKO_CONTRACTS_DIR)';
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (head !== recordedCommit()) return `the mako-contracts checkout is at ${head}, not the recorded ${recordedCommit()}`;
  if (!existsSync(join(dir, 'out', 'TokenMocks.sol', 'MockUSDC.json'))) return 'the checkout has no built MockUSDC (run forge build there)';
  return null;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

export interface Anvil {
  url: string;
  stop(): void;
}

export async function startAnvil(chainId: number): Promise<Anvil> {
  const port = await freePort();
  const proc: ChildProcess = spawn('anvil', ['--network', 'monad', '--port', String(port), '--host', '127.0.0.1', '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (r.ok) return { url, stop: () => void proc.kill('SIGKILL') };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error('anvil did not start');
}

export async function jsonRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
