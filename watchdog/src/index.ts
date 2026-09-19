// mako-watchdog: alert-only Worker (mako-design/WATCHDOG_PLAN.md r15, slice 1).
// Cron every 5 minutes; no HTTP surface; no private key; no transactions.

import { getAddress } from 'viem';
import { runOnce, type RunEnv } from './run';
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

export function readEnv(env: Env): RunEnv {
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

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const runEnv = readEnv(env);
    const stub = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName('watchdog'));
    ctx.waitUntil(
      runOnce(
        {
          fetch: (input, init) => fetch(input, init),
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          state: {
            acquire: (scheduledTime, nowMs) => stub.acquire(scheduledTime, nowMs),
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
