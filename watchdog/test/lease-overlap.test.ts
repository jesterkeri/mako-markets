// I6 says at most one run holds the lease, and r15 5.1 sets the run deadline
// (200 s) below the lease expiry (270 s) below the cron spacing (300 s) so the
// holder is always dead before the next event can take its lease. Measuring
// expiry in the cron's scheduled time instead of the holder's own clock breaks
// that chain: the two quantities are now kept in different clocks, so an event
// 300 s newer frees a lease whose holder started far less than 200 s ago.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { RUN_DEADLINE_MS } from '../src/config';
import { runOnce, type Deps } from '../src/run';
import { closedMarket, makeDeps, makeWorld, type FakeMarket, type World } from './fake';

const FIVE_MIN = 300_000;

function stateFor(name: string): Deps['state'] {
  const s = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName(name));
  return { acquire: (a) => s.acquire(a), commit: (t, a, p) => s.commit(t, a, p) };
}

/// Market ids listed in a refund command, if any.
function commandIdsIn(text: string): number[] {
  const m = text.match(/for id in ([\d ]+); do/);
  return m ? m[1].trim().split(' ').map(Number) : [];
}

describe('a live holder and the next cron event', () => {
  it('the next event takes the lease while the holder is inside its deadline, and both deliver the same refund command', async () => {
    const state = stateFor('lease-overlap');

    // A's event is delivered 150 s after its scheduled time; B's is on time.
    // A therefore starts 150 s before B, well inside its own 200 s deadline.
    const scheduledA = Date.UTC(2026, 8, 19, 12, 0);
    const scheduledB = scheduledA + FIVE_MIN;
    const wallA = scheduledA + 150_000;
    const wallB = scheduledB;
    expect(wallB - wallA).toBeLessThan(RUN_DEADLINE_MS);

    // One stuck one-sided market, two days past close: every run offers the
    // same forceRefund command for it.
    const markets: FakeMarket[] = [closedMarket(1, 'SOL:gt:102', Math.floor(wallA / 1000), 2 * 86_400, 1_000_000n, 0n)];
    const telegram: World['telegram'] = { mode: 'ok', retryAfter: 1, sent: [] };

    const wA = makeWorld({ markets, telegram, finalizedTs: Math.floor(wallA / 1000) });
    wA.clock.t = wallA;
    const wB = makeWorld({ markets, telegram, finalizedTs: Math.floor(wallB / 1000) });
    wB.clock.t = wallB;

    // Hold run A on its very first outbound request, after it has the lease.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const depsA = makeDeps(wA, state);
    const baseFetch = depsA.fetch;
    let held = false;
    depsA.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!held) {
        held = true;
        await gate;
      }
      return baseFetch(input, init);
    };

    const runA = runOnce(depsA, scheduledA);
    // Let A reach the gate: it has acquired the lease and is doing chain reads.
    for (let i = 0; i < 500 && !held; i++) await new Promise((r) => setTimeout(r, 1));
    expect(held).toBe(true);

    // B's event arrives while A is still running.
    const rB = await runOnce(makeDeps(wB, state), scheduledB);
    release();
    const rA = await runA;

    const commands = telegram.sent.filter((t) => commandIdsIn(t).length > 0);
    expect({
      // A never passed its deadline: it was alive the whole time.
      holderRanFor: wA.clock.t - wallA < RUN_DEADLINE_MS ? 'inside its 200 s deadline' : 'past its deadline',
      // So the next event must be skipped, and A must be the one that commits.
      nextEvent: `${rB.kind}${rB.reason ? ': ' + rB.reason : ''}`,
      holderCommitted: rA.committed,
      // Only one run may put a runnable forceRefund command in the chat.
      refundCommandsDelivered: commands.length,
    }).toEqual({
      holderRanFor: 'inside its 200 s deadline',
      nextEvent: 'skipped: lease_held',
      holderCommitted: true,
      refundCommandsDelivered: 1,
    });
  });
});
