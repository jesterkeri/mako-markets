// ----------------------------------------------------------------------------
// price-recorder/src/index.ts
//
// The recorder Worker (CHARTS_DS_PLAN section 2). The cron runs one tick a minute (tick.ts, plan 4.2); migration 0001
// seeds `record = 0`, so a fresh deploy calls nothing until the operator turns recording on (section 11, 16 step 4).
// The HTTP surface answers 503 until the read API (unit e) exists, which is also what a request without a token will
// get later (plan section 11).
// ----------------------------------------------------------------------------

import { runTick, DEFAULT_DATASTREAMS_URL } from './tick';

export interface Env {
  DB?: D1Database;
  DATASTREAMS_URL?: string;
  DATASTREAMS_API_KEY?: string;
  DATASTREAMS_API_SECRET?: string;
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_serving' }, { status: 503 });
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
