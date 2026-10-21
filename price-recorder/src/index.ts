// ----------------------------------------------------------------------------
// price-recorder/src/index.ts
//
// The recorder Worker (CHARTS_DS_PLAN section 2). The cron runs one tick a minute (tick.ts, plan 4.2); migration 0001
// seeds `record = 0`, so a fresh deploy calls nothing until the operator turns recording on (section 11, 16 step 4).
// The HTTP surface is the read API (read.ts, unit e): candles, latest, availability and health, behind the config
// check and the read token (plan 7.2, 11).
// ----------------------------------------------------------------------------

import { handleRead } from './read';
import { runTick, DEFAULT_DATASTREAMS_URL } from './tick';

export interface Env {
  DB?: D1Database;
  DATASTREAMS_URL?: string;
  DATASTREAMS_API_KEY?: string;
  DATASTREAMS_API_SECRET?: string;
  RECORDER_READ_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRead(req, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const apiKey = env.DATASTREAMS_API_KEY?.trim();
    const secret = env.DATASTREAMS_API_SECRET?.trim();
    await runTick({
      db: env.DB,
      // Never the global fetch detached (Workers "Illegal invocation").
      fetchImpl: (input, init) => fetch(input, init),
      base: env.DATASTREAMS_URL?.trim() || DEFAULT_DATASTREAMS_URL,
      creds: apiKey && secret ? { apiKey, secret } : null,
    });
  },
} satisfies ExportedHandler<Env>;
