// ----------------------------------------------------------------------------
// price-recorder/src/index.ts
//
// The recorder Worker (CHARTS_DS_PLAN section 2). The cron runs one tick a minute (tick.ts, plan 4.2); migration 0001
// seeds `record = 0`, so a fresh deploy calls nothing until the operator turns recording on (section 11, 16 step 4).
// The HTTP surface is the read API (read.ts, unit e): candles, latest, availability and health, behind the config
// check and the read token (plan 7.2, 11).
// ----------------------------------------------------------------------------

import { monitorRun, DEFAULT_PUBLIC_RPC_URL } from './monitor';
import { handleRead } from './read';
import { runTick, DEFAULT_DATASTREAMS_URL } from './tick';

export interface Env {
  DB?: D1Database;
  DATASTREAMS_URL?: string;
  DATASTREAMS_API_KEY?: string;
  DATASTREAMS_API_SECRET?: string;
  RECORDER_READ_TOKEN?: string;
  /// Unit f: the Healthchecks check's ping URL (a secret; without it the monitor only logs).
  HEALTHCHECKS_PING_URL?: string;
  /// Unit f: the RPC for the hourly on-chain sample (the public Monad RPC by default; no key).
  PUBLIC_RPC_URL?: string;
}

/// One tick, then the monitor (plan 12, unit f): every event the tick logs is also seen by the monitor.
export async function scheduledRun(env: Env, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<void> {
  const apiKey = env.DATASTREAMS_API_KEY?.trim();
  const secret = env.DATASTREAMS_API_SECRET?.trim();
  const events: Record<string, unknown>[] = [];
  const log = (e: Record<string, unknown>) => {
    events.push(e);
    console.log(JSON.stringify(e));
  };
  const report = await runTick({
    db: env.DB,
    // Never the global fetch detached (Workers "Illegal invocation").
    fetchImpl,
    base: env.DATASTREAMS_URL?.trim() || DEFAULT_DATASTREAMS_URL,
    creds: apiKey && secret ? { apiKey, secret } : null,
    log,
  });
  await monitorRun({ db: env.DB, fetchImpl, pingUrl: env.HEALTHCHECKS_PING_URL, rpcUrl: env.PUBLIC_RPC_URL?.trim() || DEFAULT_PUBLIC_RPC_URL, log }, report, events);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRead(req, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await scheduledRun(env);
  },
} satisfies ExportedHandler<Env>;
