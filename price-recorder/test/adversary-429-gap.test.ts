// Adversary (unit c, second pass): CHARTS_DS_PLAN 4.1 "a 429 stops all further Data Streams calls in that tick".
// tick.ts halts the limiter only after the page client has CLASSIFIED the answer, and classify (client.ts) first awaits
// the 429 body's cancel. A call already in flight that finishes inside that await frees a limiter slot, and the next
// waiting call starts although the 429 has already been received.
// Data: no report bytes are needed (every page here is the FakeStreams answer for a feed with no capture, an empty
// page); the 429 is a synthetic status with an empty body, as in tick-refusal.test.ts. The only construction is the
// timing: the 429 body's cancel takes ONE event-loop turn (setTimeout 0; a network body's cancel may be I/O), and one
// of the six calls in flight answers during it. With a cancel that settles in microtasks only, this test passes.
import { describe, expect, it } from 'vitest';

import { FakeStreams, msForLive, recordOnly, tick, virtualClock } from './tick-helpers';

const M = 1792076400; // 2026-10-15 15:00:00 UTC

describe('adversary: no call starts after a 429 was received (plan 4.1)', () => {
  it('a call in flight that answers while the 429 body is being cancelled lets one more call start after the 429 (synthetic status)', async () => {
    await recordOnly('all'); // 34 live pages: six in flight, the rest waiting on the limiter
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, []);

    let n = 0;
    let got429 = false;
    const startedAfter429: number[] = [];
    let sixInFlight!: () => void;
    const six = new Promise<void>((r) => (sixInFlight = r));
    let releaseOne!: () => void;
    const one = new Promise<void>((r) => (releaseOne = r));
    let releaseRest!: () => void;
    const rest = new Promise<void>((r) => (releaseRest = r));
    const turns = async (k: number) => {
      for (let i = 0; i < k; i++) await new Promise((r) => setTimeout(r, 0));
    };

    const fetchImpl: typeof fetch = async (input, init) => {
      const k = n++;
      if (got429) startedAfter429.push(k);
      if (n === 6) sixInFlight();
      if (k === 0) {
        await six; // the limiter's six slots are all taken
        got429 = true;
        const body = new ReadableStream({
          async cancel() {
            releaseOne(); // one call in flight answers while the 429 body is cancelled
            await turns(1);
            releaseRest();
          },
        });
        return new Response(body, { status: 429 });
      }
      if (k === 1) await one;
      else if (k < 6) await rest;
      return fake.fetch(input, init);
    };

    const r = await tick(fake, clock, { fetchImpl });
    expect(r.run?.n_429).toBe(1);
    // Six calls were in flight when the 429 arrived; none may start after it.
    expect(startedAfter429).toEqual([]);
  });
});
