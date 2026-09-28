// mako-rounds-keeper: settles MakoRoundsV1 rounds from a gas-only key (SPEC §5.5, TASKS T2.0c).
// Cron every minute; no HTTP surface. The key signs `settle` only: it holds no funds but gas, owns nothing,
// and the contract gives its sender no power (settle is permissionless; the contract derives everything).

import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeNet } from './net';
import { CHAIN_ID, runKeeper, type RunConfig, type TxRequest } from './run';
import type { KeeperState } from './state';

export { KeeperState } from './state';

export interface Env {
  KEEPER_STATE: DurableObjectNamespace<KeeperState>;
  ROUNDS_ADDRESS: string;
  KEEPER_ADDRESS: string;
  RPC_URL: string;
  DATASTREAMS_URL: string;
  DRY_RUN?: string;
  KEEPER_PRIVATE_KEY: string;
  DATASTREAMS_API_KEY: string;
  DATASTREAMS_API_SECRET: string;
  HEALTHCHECKS_PING_URL: string;
}

/// A run that starts must finish well inside the cron period and the lease.
const RUN_BUDGET_MS = 40_000;
/// T0.1c keeper bound: at most 10 requests per round; one round per run, plus the Healthchecks ping.
const MAX_REQUESTS = 11;

function address(raw: string | undefined, label: string): Hex {
  if (!raw) throw new Error(`${label} is not set`);
  try {
    return getAddress(raw.trim());
  } catch {
    throw new Error(`${label} is not a valid address`);
  }
}

function required(raw: string | undefined, label: string): string {
  const v = raw?.trim();
  if (!v) throw new Error(`${label} is not set`);
  return v;
}

function https(raw: string | undefined, label: string): string {
  const v = required(raw, label).replace(/\/$/, '');
  if (new URL(v).protocol !== 'https:') throw new Error(`${label} must be HTTPS`);
  return v;
}

/// Config and key, checked before a run starts. A bad value throws with the variable's NAME only, so the run
/// never starts and Healthchecks, missing its ping, reports the keeper down.
export function readEnv(env: Env): { cfg: RunConfig; key: Hex } {
  const key = required(env.KEEPER_PRIVATE_KEY, 'KEEPER_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('KEEPER_PRIVATE_KEY is not a 32-byte hex key');
  const keeperAddress = address(env.KEEPER_ADDRESS, 'KEEPER_ADDRESS');
  // The configured public address must be the key's, so a wrong secret is caught before it signs anything.
  if (privateKeyToAccount(key as Hex).address !== keeperAddress)
    throw new Error('KEEPER_PRIVATE_KEY does not belong to KEEPER_ADDRESS');
  const cfg: RunConfig = {
    roundsAddress: address(env.ROUNDS_ADDRESS, 'ROUNDS_ADDRESS'),
    keeperAddress,
    rpcUrl: https(env.RPC_URL, 'RPC_URL'),
    datastreamsUrl: https(env.DATASTREAMS_URL, 'DATASTREAMS_URL'),
    datastreamsKey: required(env.DATASTREAMS_API_KEY, 'DATASTREAMS_API_KEY'),
    datastreamsSecret: required(env.DATASTREAMS_API_SECRET, 'DATASTREAMS_API_SECRET'),
    // Anything but the exact string "false" is a dry run: sending must be switched on deliberately.
    dryRun: env.DRY_RUN?.trim() !== 'false',
  };
  https(env.HEALTHCHECKS_PING_URL, 'HEALTHCHECKS_PING_URL');
  return { cfg, key: key as Hex };
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { cfg, key } = readEnv(env);
    const account = privateKeyToAccount(key);
    const net = makeNet(fetch, () => Date.now(), (ms) => new Promise((r) => setTimeout(r, ms)), Date.now() + RUN_BUDGET_MS, MAX_REQUESTS);
    const stub = env.KEEPER_STATE.get(env.KEEPER_STATE.idFromName('keeper'));
    const ping = async (kind: 'ok' | 'fail', body: string) => {
      const base = env.HEALTHCHECKS_PING_URL.trim().replace(/\/$/, '');
      // Best effort: a failed ping is itself caught by Healthchecks as a missing ping.
      try {
        await fetch(kind === 'ok' ? base : `${base}/fail`, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
      } catch {
        /* reported by absence */
      }
    };
    const outcome = await runKeeper(cfg, {
      net,
      state: {
        acquire: (now) => stub.acquire(now),
        recordInFlight: (t, f, now) => stub.recordInFlight(t, f, now),
        commit: (t, m, now) => stub.commit(t, m, now),
      },
      sign: (tx: TxRequest) =>
        account.signTransaction({ chainId: CHAIN_ID, type: 'eip1559', value: 0n, ...tx }),
      hmac: hmacSha256Hex,
      ping,
    });
    // One line per run: status and a secret-free detail, never a URL, header or key.
    console.log(JSON.stringify({ keeper: outcome.status, detail: outcome.detail ?? null, cron: event.scheduledTime }));
    void ctx;
  },
};
