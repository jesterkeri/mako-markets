// Adversary pass on the shared Envio budget (envio-budget.ts, 0be93d3). Spec point 2: across any number of instances,
// no rolling 60 s ever sees more than ME_ENVIO_PER_MINUTE Me calls ADMITTED, clock skew between instances included.
// The reserve script judges the window by the `now` the calling instance passes in, taken before the Upstash request
// is sent, not by the store's own clock at the moment the slot is written. So a slot can be recorded as older than it
// is, and it leaves the window early: here, by an instance clock 1 ms fast, and by an Upstash round trip of 1.5 s
// (inside the 2 s timeout). Admission times below are the store's clock (the fake's `now`) when the EVAL ran.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerUpstash, fakeUpstash, type FakeUpstash } from './helpers/fake-upstash';

let up: FakeUpstash;
/// The store's clock (real time).
let t = 0;
/// Real time at which each slot was admitted by the store.
let admitted: number[] = [];
/// Upstash round-trip latency applied before the next EVAL reaches the store, then reset.
let latencyMs = 0;

beforeEach(() => {
  vi.resetModules();
  t = 1_800_000_000_000;
  admitted = [];
  latencyMs = 0;
  up = fakeUpstash(() => t);
  process.env.UPSTASH_REDIS_REST_URL = up.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = up.token;
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== up.url) throw new Error(`unscripted fetch ${url}`);
    t += latencyMs;
    latencyMs = 0;
    const res = await answerUpstash(up, init);
    const body = (await res.clone().json()) as { result?: unknown };
    if (typeof body.result === 'number' && body.result > 0) admitted.push(t);
    return res;
  }) as typeof fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

const load = () => import('@/lib/envio-budget');

function worstWindow(xs: number[]): number {
  let worst = 0;
  for (const from of xs) worst = Math.max(worst, xs.filter((x) => x >= from && x < from + 60_000).length);
  return worst;
}

describe('adversary: the rolling-minute cap holds in real time', () => {
  it('two instances, one clock 1 ms fast: no 60 s of real time admits more than ME_ENVIO_PER_MINUTE', async () => {
    const a = await load();
    vi.resetModules();
    const b = await load();
    const start = t;
    // Instance A (correct clock) takes the whole budget at real time `start`.
    for (let i = 0; i < a.ME_ENVIO_PER_MINUTE; i++) await a.reserveEnvioCall();
    // 59.999 s later, instance B (whose own clock would read 1 ms ahead; the budget no longer reads instance clocks) asks.
    t = start + 59_999;
    for (let i = 0; i < b.ME_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall().catch(() => undefined);
    expect(worstWindow(admitted)).toBeLessThanOrEqual(a.ME_ENVIO_PER_MINUTE);
  });

  it('one instance, synced clocks, one Upstash round trip of 1.5 s: no 60 s of real time admits more than the cap', async () => {
    const b = await load();
    const start = t;
    // A reservation starts at real time `start`; its EVAL reaches the store 1.5 s later.
    latencyMs = 1_500;
    await b.reserveEnvioCall();
    // The rest of the budget goes immediately after, with no latency.
    for (let i = 1; i < b.ME_ENVIO_PER_MINUTE; i++) await b.reserveEnvioCall();
    // Exactly 60 s after the slow reservation STARTED (58.5 s after it was admitted), one more call.
    t = start + 60_000;
    await b.reserveEnvioCall().catch(() => undefined);
    expect(worstWindow(admitted)).toBeLessThanOrEqual(b.ME_ENVIO_PER_MINUTE);
  });
});
