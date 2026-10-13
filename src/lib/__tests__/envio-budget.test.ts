// The shared Envio budget for rounds in Me (Codex ME_ROUNDS R5, Joshua 2026-10-13): one log across every app instance,
// never more than ME_ENVIO_PER_MINUTE calls in ANY rolling 60 s, and every failure to check it refuses the call (fail
// closed). The token never reaches an error message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerUpstash, fakeUpstash, type FakeUpstash } from './helpers/fake-upstash';

let up: FakeUpstash;
let t = 0;

beforeEach(() => {
  vi.resetModules();
  t = 1_800_000_000_000;
  up = fakeUpstash(() => t);
  process.env.UPSTASH_REDIS_REST_URL = up.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = up.token;
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== up.url) throw new Error(`unscripted fetch ${url}`);
    return answerUpstash(up, init);
  }) as typeof fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[k];
});

const load = () => import('@/lib/envio-budget');

describe('reserveEnvioCall', () => {
  it('allows ME_ENVIO_PER_MINUTE calls in a rolling minute, refuses the next, and frees slots exactly 60 s later', async () => {
    const b = await load();
    for (let i = 0; i < b.ME_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall(t + i);
    await expect(b.reserveEnvioCall(t + 100)).rejects.toBeInstanceOf(b.EnvioBudgetExhausted);
    await expect(b.reserveEnvioCall(t + b.WINDOW_MS - 1)).rejects.toBeInstanceOf(b.EnvioBudgetExhausted);
    await expect(b.reserveEnvioCall(t + b.WINDOW_MS + 1)).resolves.toBeUndefined();
  });

  it('two app instances (two module copies) share one log: together they get the budget, not double', async () => {
    const a = await load();
    vi.resetModules();
    const c = await load();
    expect(a).not.toBe(c);
    let ok = 0;
    for (let i = 0; i < 200; i++) {
      try {
        await (i % 2 ? a : c).reserveEnvioCall(t + i);
        ok++;
      } catch (e) {
        expect((e as Error).name).toBe('EnvioBudgetExhausted');
      }
    }
    expect(ok).toBe(a.ME_ENVIO_PER_MINUTE);
  });

  it('a burst of 20 calls every second for 5 minutes: no 60 s span ever gets more than ME_ENVIO_PER_MINUTE through', async () => {
    const b = await load();
    const passed: number[] = [];
    const start = t;
    for (let s = 0; s < 300; s++) {
      for (let k = 0; k < 20; k++) {
        const now = start + s * 1000 + k;
        try {
          await b.reserveEnvioCall(now);
          passed.push(now);
        } catch {
          // refused
        }
      }
    }
    let worst = 0;
    for (const from of passed) worst = Math.max(worst, passed.filter((x) => x >= from && x < from + 60_000).length);
    expect(worst).toBe(b.ME_ENVIO_PER_MINUTE);
  });

  it.each([
    ['not configured', () => { delete process.env.UPSTASH_REDIS_REST_URL; }],
    ['a non-https URL', () => { process.env.UPSTASH_REDIS_REST_URL = 'http://fake-upstash.test'; }],
    ['unreachable', () => { up.override = () => { throw new TypeError('fetch failed'); }; }],
    ['HTTP 500', () => { up.override = () => new Response('oops', { status: 500 }); }],
    ['an error body', () => { up.override = () => Response.json({ error: 'ERR' }); }],
    ['not JSON', () => { up.override = () => new Response('<html>', { status: 200 }); }],
    ['a count that is not a number', () => { up.override = () => Response.json({ result: 'many' }); }],
  ])('%s: the call is refused (fail closed), never allowed', async (_n, setup) => {
    setup();
    const b = await load();
    const err = await b.reserveEnvioCall(t).then(() => null, (e: Error) => e);
    expect(err?.name).toBe('EnvioBudgetUnavailable');
    expect(String(err?.message)).not.toContain(up.token);
  });

  it('uses the Vercel KV-style names when the Upstash ones are absent', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = up.url;
    process.env.KV_REST_API_TOKEN = up.token;
    const b = await load();
    await expect(b.reserveEnvioCall(t)).resolves.toBeUndefined();
  });

  it('session keys hash the session id: the raw id is never stored', async () => {
    const b = await load();
    expect(b.sessionKey('abc-session')).toMatch(/^mako:me:sid:[0-9a-f]{64}$/);
    expect(b.sessionKey('abc-session')).not.toContain('abc-session');
  });
});
