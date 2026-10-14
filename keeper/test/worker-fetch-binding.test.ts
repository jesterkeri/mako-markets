// The deployed Worker's own scheduled() wiring, run inside workerd. The rounds watch, deployed 2026-10-10 with the
// same wiring, logged "rpc-error" on every run: index.ts passed the global `fetch` as a value and net.ts called it
// as `net.fetch(...)`, and workerd's fetch throws "Illegal invocation" when `this` is not the global scope. Every
// other test injects its own fake fetch, so none could see it. The fake below throws exactly as workerd's does on
// a foreign `this` and answers every request with an RPC error, so the run stops early; what is asserted is only
// that the keeper's requests reached the network with a valid `this`.
import { env } from 'cloudflare:workers';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('scheduled() calls fetch the way workerd requires', () => {
  it('every request reaches fetch with a valid this', async () => {
    let reached = 0;
    let illegal = 0;
    globalThis.fetch = function (this: unknown, _input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        illegal++;
        return Promise.reject(new TypeError('Illegal invocation'));
      }
      reached++;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const err = (id: unknown) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'test-only' } });
      return Promise.resolve(Response.json(Array.isArray(body) ? body.map((c: { id: unknown }) => err(c.id)) : err(body?.id ?? 0)));
    } as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A fresh test-only key, with KEEPER_ADDRESS set to match it (readEnv refuses a key for another address).
    const key = generatePrivateKey();
    const testEnv: Env = {
      ...(env as unknown as Env),
      DRY_RUN: 'true',
      KEEPER_ADDRESS: privateKeyToAddress(key),
      KEEPER_PRIVATE_KEY: key,
      DATASTREAMS_API_KEY: 'test-only',
      DATASTREAMS_API_SECRET: 'test-only',
      HEALTHCHECKS_PING_URL: 'https://hc.example/test-only',
    };
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    // The RPC errors may end the run with an error of its own; only the fetch calls are under test.
    await worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *', noRetry() {} } as ScheduledController, testEnv, ctx).catch(() => {});
    expect({ illegal, reachedSome: reached > 0 }).toEqual({ illegal: 0, reachedSome: true });
  });
});
