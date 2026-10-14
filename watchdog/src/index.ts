// mako-watchdog: alert-only Worker (mako-design/WATCHDOG_PLAN.md r15, slice 1).
// Cron every 5 minutes; no HTTP surface; no private key; no transactions.

import { getAddress } from 'viem';
import { manifestLine, pingHealthchecks } from './alerts';
import { FETCH_TIMEOUT_MS } from './config';
import { makeNet } from './net';
import { runGuarded, type RunEnv } from './run';
import type { WatchdogState } from './state';

export { WatchdogState } from './state';

export interface Env {
  WATCHDOG_STATE: DurableObjectNamespace<WatchdogState>;
  MAKO_ADDRESS: string;
  RESOLVER_ADDRESS: string;
  PUBLIC_RPC_URL: string;
  APP_URL: string;
  PROVIDER_B_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  HEALTHCHECKS_PING_URL: string;
  DRY_RUN?: string;
}

/// Env addresses are trimmed and EIP-55 checked (src/lib/contract.ts: the
/// Vercel env once carried a trailing newline into production). A missing or
/// malformed value throws, so the run never starts and Healthchecks goes Down.
function address(raw: string | undefined, label: string): string {
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

/// Scheme, host and port, lowercased: the part that names an operator.
export function origin(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`.toLowerCase();
}

export function readEnv(env: Env): RunEnv {
  const run = readEnvUnchecked(env);
  // The second-source confirmation means nothing if both URLs reach the same
  // endpoint (review r2). Distinct origins are necessary, not sufficient:
  // operator independence is recorded before deploy (A6 evidence).
  if (origin(run.providerBUrl) === origin(run.publicRpcUrl)) {
    throw new Error('PROVIDER_B_URL and PUBLIC_RPC_URL have the same origin; provider B must be an independent operator');
  }
  if (new URL(run.providerBUrl).protocol !== 'https:' || new URL(run.publicRpcUrl).protocol !== 'https:') {
    throw new Error('PROVIDER_B_URL and PUBLIC_RPC_URL must be HTTPS');
  }
  return run;
}

function readEnvUnchecked(env: Env): RunEnv {
  return {
    makoAddress: address(env.MAKO_ADDRESS, 'MAKO_ADDRESS'),
    resolverAddress: address(env.RESOLVER_ADDRESS, 'RESOLVER_ADDRESS'),
    publicRpcUrl: required(env.PUBLIC_RPC_URL, 'PUBLIC_RPC_URL'),
    appUrl: required(env.APP_URL, 'APP_URL').replace(/\/$/, ''),
    providerBUrl: required(env.PROVIDER_B_URL, 'PROVIDER_B_URL'),
    telegramToken: required(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: required(env.TELEGRAM_CHAT_ID, 'TELEGRAM_CHAT_ID'),
    healthchecksUrl: required(env.HEALTHCHECKS_PING_URL, 'HEALTHCHECKS_PING_URL'),
    dryRun: env.DRY_RUN === '1',
  };
}

/// A configuration failure is reported with the one value that does not
/// depend on the rest of the configuration being valid (review r12). Before
/// this, `readEnv` threw outside `runGuarded`, so a malformed PROVIDER_B_URL
/// produced no request at all and the only signal was the dead-man check
/// going Down after its grace. `pingHealthchecks` validates the URL itself,
/// so a bad one here simply makes no request rather than reaching anywhere.
async function reportConfigFailure(env: Env, err: unknown, log: (line: string) => void): Promise<void> {
  const raw = err instanceof Error ? err.message : 'configuration is invalid';
  // readEnv's messages name the variable, never its value, but bound and
  // sanitise anyway: nothing from the environment belongs in an alert unread.
  const detail = raw.slice(0, 200).replace(/[^\x20-\x7e]/g, '').trim() || 'configuration is invalid';
  const iso = new Date().toISOString();
  const body = `mako-watchdog ${iso} INEFFECTIVE S1\nconfiguration rejected before the run started: ${detail}\n${manifestLine([], ['ds'])}`;
  log(`[watchdog] ${iso} configuration rejected: ${detail}`);
  const net = makeNet((i, x) => fetch(i, x), () => Date.now(), (ms) => new Promise((r) => setTimeout(r, ms)), Date.now() + FETCH_TIMEOUT_MS, 1);
  try {
    await pingHealthchecks(net, env.HEALTHCHECKS_PING_URL ?? '', 'fail', body, false, log);
  } catch {
    // Nothing left to try: the dead-man check goes Down after its grace.
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    let runEnv: RunEnv;
    try {
      runEnv = readEnv(env);
    } catch (err) {
      ctx.waitUntil(reportConfigFailure(env, err, (line) => console.log(line)));
      return;
    }
    const stub = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName('watchdog'));
    ctx.waitUntil(
      runGuarded(
        {
          fetch: (input, init) => fetch(input, init),
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          state: {
            acquire: (scheduledTime) => stub.acquire(scheduledTime),
            commit: (token, scheduledTime, payload) => stub.commit(token, scheduledTime, payload),
          },
          env: runEnv,
          log: (line) => console.log(line),
        },
        event.scheduledTime,
      ),
    );
  },

  // No HTTP trigger (like cf-worker): nothing to call from outside.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
