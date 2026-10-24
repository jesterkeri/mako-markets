// Adversary (unit c, third pass): CHARTS_DS_PLAN 4.1 "a 429 stops all further Data Streams calls in that tick", and
// client.ts's own onStatus contract "a 429 must halt the tick before any other call can start".
// The limiter checks the halt only when it GRANTS a slot (limiter.ts grant). The page client then signs the request
// (reportHeaders, an async HMAC through crypto.subtle) and only after that calls fetch. A 429 that arrives while a
// granted call is still being signed halts the limiter, but nothing checks the halt again before that call's fetch, so
// the request goes to Data Streams after the 429 was received.
// Data: no report bytes are needed (every 200 here is the FakeStreams answer for a feed with no capture, an empty
// page); the 429 is a synthetic status with an empty body, as in tick-refusal.test.ts. The HMAC is the resolver's own
// hmacSha256Hex, unchanged in output; the only construction is the timing: the 429 is delivered while the seventh
// request is being signed (crypto.subtle is asynchronous, so that window exists with the real signer too).
import { describe, expect, it } from 'vitest';

import { hmacSha256Hex, type HmacHex } from '../../cf-worker/src/datastreams';
import { FakeStreams, msForLive, recordOnly, tick, virtualClock } from './tick-helpers';

const M = 1792076400; // 2026-10-15 15:00:00 UTC

describe('adversary: no request is sent after a 429 was received (plan 4.1)', () => {
  it('a call granted before the 429 but still signing when it arrives is sent after the 429 (synthetic status)', async () => {
    await recordOnly('all'); // 34 live pages: six in flight, the rest waiting on the limiter
    const clock = virtualClock(msForLive(M));
    const fake = new FakeStreams(clock, []);

    const turns = async (k: number) => {
      for (let i = 0; i < k; i++) await new Promise((r) => setTimeout(r, 0));
    };

    let n = 0;
    let got429 = false;
    const sentAfter429: number[] = [];
    let k0Sent!: () => void;
    const k0 = new Promise<void>((r) => (k0Sent = r));
    let send429!: () => void;
    const go429 = new Promise<void>((r) => (send429 = r));
    let releaseRest!: () => void;
    const rest = new Promise<void>((r) => (releaseRest = r));

    const fetchImpl: typeof fetch = async (input, init) => {
      const k = n++;
      if (got429) sentAfter429.push(k);
      if (k === 0) {
        k0Sent();
        await go429;
        got429 = true;
        return new Response(null, { status: 429 });
      }
      if (k >= 2 && k < 6) await rest; // calls 2 to 5 stay in flight; call 1 answers at once and frees one slot
      return fake.fetch(input, init);
    };

    let signs = 0;
    const hmac: HmacHex = async (secret, message) => {
      const s = signs++;
      if (s === 6) {
        // The seventh request was granted (call 1's slot) and is being signed: the 429 for call 0 arrives now.
        await k0;
        send429();
        await turns(3);
        releaseRest();
      }
      return hmacSha256Hex(secret, message);
    };

    const r = await tick(fake, clock, { fetchImpl, hmac });
    expect(r.run?.n_429).toBeGreaterThanOrEqual(1);
    // The 429 had arrived (and halted the limiter) before the seventh request was sent; no request may follow it.
    expect(sentAfter429).toEqual([]);
  });
});
