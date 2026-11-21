// Adversary attacks on the market object (plan 6.2: "one match at a time", in-flight orders are in no other proposal).
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handleAlarm } from '../src/market';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

describe('adversary: overlapping match passes (a Durable Object lets a fetch and an alarm interleave at every await on the network)', () => {
  it('two passes that run at once never hand the same order to the settler twice', async () => {
    for (const n of ['directMakerSell', 'directTakerBuy']) {
      const v = vec(n);
      fund(h.w, v.order, 900_000_000n);
      await h.place(v); // settler refuses: both stay booked and unmarked
    }
    h.settled.length = 0;
    h.settleAccepts = true;
    await runInDurableObject(h.stub, async (_i, state) => {
      await Promise.all([handleAlarm(state, env as Env, h.deps), handleAlarm(state, env as Env, h.deps)]);
    });
    expect(h.settled).toHaveLength(1);
  });
});
