// mako-settlement-keeper: settles MakoRoundsV1 rounds, and refunds overdue rounds and overdue V4 pools, from a
// gas-only key (SPEC §5.5, TASKS T2.0c; automatic refunds, Joshua 2026-09-29).
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
  POOLS_ADDRESS: string;
  /// ISO time. When later than the breaker's trip, automatic V4 refunds resume. Unset: never reset.
  REFUND_BREAKER_RESET?: string;
  KEEPER_ADDRESS: string;
  RPC_URL: string;
  /// Secret (an Alchemy URL carries its key): used for a whole run after a run that ended in an RPC failure.
  RPC_FALLBACK_URL?: string;
  DATASTREAMS_URL: string;
  DRY_RUN?: string;
  KEEPER_PRIVATE_KEY: string;
  DATASTREAMS_API_KEY: string;
  DATASTREAMS_API_SECRET: string;
  HEALTHCHECKS_PING_URL: string;
}

/// A run that starts must finish well inside the cron period and the lease (LEASE_MS 50 s, taken after this clock
/// starts, so at least 5 s is left for the commit). 45 s, not 40 s, since run.ts keeps a full request timeout in hand
/// before signing: with 40 s that reserve stopped settlements at answer times production handled (adversary on 52b73f2).
const RUN_BUDGET_MS = 45_000;
/// Requests one run may make through `net` (the Healthchecks ping uses its own fetch). One JSON-RPC call per request
/// since 2026-11-03 (src/rpc.ts), so the worst path is 17: an earlier transaction's receipt, nonce, by-hash and
/// pending nonce (4) and the other provider's by-hash when it was sent again there (1), the due reads (2), the close
/// times (1), two reports (2), the pre-send reads (6) and the send (1). It was 11 (T0.1c: 10 a round) while calls went
/// as array batches.
const MAX_REQUESTS = 17;

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
  let protocol: string;
  try {
    protocol = new URL(v).protocol;
  } catch {
    // The runtime's own message can quote the value, and RPC_FALLBACK_URL carries a provider key.
    throw new Error(`${label} is not a valid URL`);
  }
  if (protocol !== 'https:') throw new Error(`${label} must be HTTPS`);
  return v;
}

/// Config and key, checked before a run starts. A bad value throws with the variable's NAME only, so the run
/// never starts and Healthchecks, missing its ping, reports the keeper down.
export function readEnv(env: Env): { cfg: RunConfig; key: Hex } {
  const key = required(env.KEEPER_PRIVATE_KEY, 'KEEPER_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('KEEPER_PRIVATE_KEY is not a 32-byte hex key');
  const keeperAddress = address(env.KEEPER_ADDRESS, 'KEEPER_ADDRESS');
  // The configured public address must be the key's, so a wrong secret is caught before it signs anything.
  // viem's own error for an out-of-range key prints the key as a decimal, so it is never let through.
  let derived: string;
  try {
    derived = privateKeyToAccount(key as Hex).address;
  } catch {
    throw new Error('KEEPER_PRIVATE_KEY is not a valid secp256k1 key');
  }
  if (derived !== keeperAddress) throw new Error('KEEPER_PRIVATE_KEY does not belong to KEEPER_ADDRESS');
  const cfg: RunConfig = {
    roundsAddress: address(env.ROUNDS_ADDRESS, 'ROUNDS_ADDRESS'),
    poolsAddress: address(env.POOLS_ADDRESS, 'POOLS_ADDRESS'),
    breakerResetAt: breakerReset(env.REFUND_BREAKER_RESET),
    keeperAddress,
    rpcUrl: https(env.RPC_URL, 'RPC_URL'),
    fallbackRpcUrl: env.RPC_FALLBACK_URL?.trim() ? https(env.RPC_FALLBACK_URL, 'RPC_FALLBACK_URL') : null,
    datastreamsUrl: https(env.DATASTREAMS_URL, 'DATASTREAMS_URL'),
    datastreamsKey: required(env.DATASTREAMS_API_KEY, 'DATASTREAMS_API_KEY'),
    datastreamsSecret: required(env.DATASTREAMS_API_SECRET, 'DATASTREAMS_API_SECRET'),
    // Anything but the exact string "false" is a dry run: sending must be switched on deliberately.
    dryRun: env.DRY_RUN?.trim() !== 'false',
  };
  https(env.HEALTHCHECKS_PING_URL, 'HEALTHCHECKS_PING_URL');
  return { cfg, key: key as Hex };
}

/// REFUND_BREAKER_RESET as ms, or null when unset. A value that is set but unparseable stops the run: a typo
/// must not silently leave refunds halted or, worse, be read as a reset.
function breakerReset(raw: string | undefined): number | null {
  const v = raw?.trim();
  if (!v) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error('REFUND_BREAKER_RESET is not an ISO date-time');
  return ms;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

const worker = {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { cfg, key } = readEnv(env);
    const account = privateKeyToAccount(key);
    const net = makeNet((i, x) => fetch(i, x), () => Date.now(), (ms) => new Promise((r) => setTimeout(r, ms)), Date.now() + RUN_BUDGET_MS, MAX_REQUESTS);
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
        recordInFlight: (t, f, now, extra) => stub.recordInFlight(t, f, now, extra),
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

export default worker;
