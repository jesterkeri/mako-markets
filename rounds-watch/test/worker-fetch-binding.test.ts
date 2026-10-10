// The deployed Worker's own scheduled() wiring, run inside workerd. Deployed 2026-10-10, every run logged
// "rpc-error": index.ts passed the global `fetch` as a value and net.ts called it as `net.fetch(...)`, and
// workerd's fetch throws "Illegal invocation" when `this` is not the global scope, which net.ts reports as a
// network failure. Every other test injects its own fake fetch, so none could see it. The fake below throws
// exactly as workerd's does when called with a foreign `this`, so passing the bare global fails this test.
import { env } from 'cloudflare:workers';
import { encodeAbiParameters } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);

describe('scheduled() calls fetch the way workerd requires', () => {
  it('a run with no rounds is quiet and pings Healthchecks, with fetch called unbound', async () => {
    const calls: string[] = [];
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== undefined && this !== globalThis) return Promise.reject(new TypeError('Illegal invocation'));
      const url = String(input);
      calls.push(url.startsWith('https://hc.example') ? 'healthchecks' : 'rpc');
      if (url.startsWith('https://hc.example')) return Promise.resolve(new Response('OK'));
      const batch = JSON.parse(String(init?.body)) as { id: number }[];
      // roundCount() = 0, DURATION() = 900: a contract with no rounds yet, as deployed today.
      const results = [word(0n), word(900n)];
      return Promise.resolve(Response.json(batch.map((c) => ({ jsonrpc: '2.0', id: c.id, result: results[c.id] }))));
    } as typeof fetch;
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    const testEnv: Env = {
      ...(env as unknown as Env),
      TELEGRAM_BOT_TOKEN: '1:test-only',
      TELEGRAM_CHAT_ID: '1',
      HEALTHCHECKS_PING_URL: 'https://hc.example/test-only',
      DATASTREAMS_API_KEY: 'test-only',
      DATASTREAMS_API_SECRET: 'test-only',
    };
    await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, testEnv);
    expect(logs.map((l) => JSON.parse(l).watch)).toEqual(['quiet']);
    expect(calls).toEqual(['rpc', 'healthchecks']);
  });
});
