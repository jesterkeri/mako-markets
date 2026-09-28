// mako-rounds-watch: alert-only liveness watch for MakoRoundsV1 (TASKS T2.0d, INVARIANTS N21).
// Cron every 5 minutes; no HTTP surface; no wallet key; sends nothing on-chain. Separate from the keeper so
// it fails independently of it, and from the V4 watchdog, which by design never holds credentials or signs.

import { getAddress, type Hex } from 'viem';
import { makeNet, send } from './net';
import { runWatch, type WatchConfig } from './run';
import type { WatchState } from './state';

export { WatchState } from './state';

export interface Env {
  WATCH_STATE: DurableObjectNamespace<WatchState>;
  ROUNDS_ADDRESS: string;
  RPC_URL: string;
  DATASTREAMS_URL: string;
  DATASTREAMS_API_KEY: string;
  DATASTREAMS_API_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  HEALTHCHECKS_PING_URL: string;
}

const RUN_BUDGET_MS = 120_000;
/// 2 RPC batches + 2 reports for each of 4 rounds + Telegram + Healthchecks.
const MAX_REQUESTS = 14;

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

/// Config checked before a run starts. Errors name the variable, never its value.
export function readEnv(env: Env): WatchConfig {
  let rounds: Hex;
  try {
    rounds = getAddress(required(env.ROUNDS_ADDRESS, 'ROUNDS_ADDRESS'));
  } catch (e) {
    throw String(e).includes('is not set') ? e : new Error('ROUNDS_ADDRESS is not a valid address');
  }
  required(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN');
  required(env.TELEGRAM_CHAT_ID, 'TELEGRAM_CHAT_ID');
  https(env.HEALTHCHECKS_PING_URL, 'HEALTHCHECKS_PING_URL');
  return {
    roundsAddress: rounds,
    rpcUrl: https(env.RPC_URL, 'RPC_URL'),
    datastreamsUrl: https(env.DATASTREAMS_URL, 'DATASTREAMS_URL'),
    datastreamsKey: required(env.DATASTREAMS_API_KEY, 'DATASTREAMS_API_KEY'),
    datastreamsSecret: required(env.DATASTREAMS_API_SECRET, 'DATASTREAMS_API_SECRET'),
  };
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

const worker = {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const cfg = readEnv(env);
    const net = makeNet(fetch, () => Date.now(), (ms) => new Promise((r) => setTimeout(r, ms)), Date.now() + RUN_BUDGET_MS, MAX_REQUESTS);
    const stub = env.WATCH_STATE.get(env.WATCH_STATE.idFromName('rounds-watch'));
    const outcome = await runWatch(cfg, {
      net,
      state: { acquire: (now) => stub.acquire(now), commit: (t, m, now) => stub.commit(t, m, now) },
      hmac: hmacSha256Hex,
      // Confirmed only on HTTP 200 with Telegram's `ok: true`. The URL carries the token, so failures are
      // reduced to a boolean and never logged.
      telegram: async (text) => {
        const res = await send(net, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN.trim()}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID.trim(), text, disable_web_page_preview: true }),
        });
        if (!res.ok) return false;
        try {
          return (JSON.parse(res.text) as { ok?: unknown }).ok === true;
        } catch {
          return false;
        }
      },
      ping: async (kind, body) => {
        const base = env.HEALTHCHECKS_PING_URL.trim().replace(/\/$/, '');
        await send(net, kind === 'ok' ? base : `${base}/fail`, { method: 'POST', body: body.slice(0, 10_000) });
      },
    });
    console.log(JSON.stringify({ watch: outcome.status, conditions: outcome.conditions, cron: event.scheduledTime }));
  },
};

export default worker;
