// Review r12, all three findings. Each is about the watchdog failing to speak,
// or speaking falsely, in a situation it was built to report on.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { RUN_DEADLINE_MS } from '../src/config';
import { runOnce, type Deps } from '../src/run';
import { closedMarket, HC, makeDeps, makeWorld, type World } from './fake';

let n = 0;
const FIVE_MIN = 300_000;
function stateFor(name: string): Deps['state'] {
  const s = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName(`${name}-${n++}`));
  return { acquire: (a) => s.acquire(a), commit: (t, a, p) => s.commit(t, a, p) };
}
const nowS = (w: World) => Math.floor(w.clock.t / 1000);
async function tick(w: World, state: Deps['state'], mutate: (d: Deps) => Deps = (d) => d) {
  const scheduled = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
  w.pageRequestIndex = 0;
  w.latestBlock += 600;
  w.finalizedBlock += 600;
  w.finalizedTs = nowS(w);
  const r = await runOnce(mutate(makeDeps(w, state)), scheduled);
  w.clock.t = scheduled + FIVE_MIN + 1_000;
  return r;
}

// MAJOR: `net.send` refuses to fetch once the run's deadline has passed, so a
// late `finish()` made NO request. A slow or unavailable Durable Object is
// exactly the incident the independent path exists for.
describe('a Durable Object that answers late still produces one ping', () => {
  it('when acquire throws after the deadline', async () => {
    const w = makeWorld();
    const state: Deps['state'] = {
      acquire: async () => {
        w.clock.t += RUN_DEADLINE_MS + 1_000;
        throw new Error('DO unavailable');
      },
      commit: async () => ({ ok: false, reason: 'fenced' }),
    };
    const r = await tick(w, state);
    expect(r.ping).toBe('fail');
    expect(w.hc.pings).toHaveLength(1);
    expect(w.hc.pings[0].url).toMatch(/\/fail$/);
    expect(w.hc.pings[0].body).toContain('state unavailable');
  });

  it('when acquire refuses the lease after the deadline', async () => {
    const w = makeWorld();
    const state: Deps['state'] = {
      acquire: async () => {
        w.clock.t += RUN_DEADLINE_MS + 1_000;
        return { ok: false, reason: 'lease_held' };
      },
      commit: async () => ({ ok: false, reason: 'fenced' }),
    };
    const r = await tick(w, state);
    expect(r.ping).toBe('log');
    expect(w.hc.pings).toHaveLength(1);
    expect(w.hc.pings[0].url).toMatch(/\/log$/);
    expect(w.hc.pings[0].body).toContain('lease held by another run');
  });
});

// MAJOR: a dry run printed the messages and then recorded them as DELIVERED,
// so a rehearsal muted the first real alert for a reminder period and could
// step past a creation alert for good.
describe('a dry run must not claim Telegram accepted anything', () => {
  it('leaves delivery state untouched, and the next real run offers everything again', async () => {
    const w = makeWorld();
    const state = stateFor('dry');
    // Bootstrap for real first, so the market that follows is genuinely NEW
    // and raises a creation alert. Markets present at bootstrap are listed in
    // the bootstrap message instead, so the cursor moves past them either way.
    const stuck = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
    w.markets = [stuck];
    const first = await tick(w, state);
    const before = first.payload!.criticals.find((c) => c.key === 'm:0')!;
    expect(before.lastDeliveredAt).not.toBe(null); // the real run did deliver it
    // A new market with a paused symbol, which is a creation alert.
    w.markets.push(closedMarket(5, 'KO:gt:60', nowS(w), 600, 0n, 0n));
    w.clock.t += 6 * 3600_000; // the stuck market's reminder and command are due again
    w.telegram.sent = [];

    const dry = await tick(w, state, (d) => ({ ...d, env: { ...d.env, dryRun: true } }));
    expect(dry.telegramMessages.length).toBeGreaterThan(0); // it DID render them
    expect(dry.telegramConfirmed.every((c) => c === false)).toBe(true); // but none delivered
    expect(w.telegram.sent).toEqual([]); // and nothing left the Worker
    const dryCrit = dry.payload!.criticals.find((c) => c.key === 'm:0')!;
    // Unchanged, not null: the earlier REAL run legitimately set these. What
    // the dry run may not do is move them, which is what muted the first live
    // alert for a reminder period.
    expect(dryCrit.lastDeliveredAt).toBe(before.lastDeliveredAt);
    expect(dryCrit.lastCommandAt).toBe(before.lastCommandAt);
    expect(dry.payload!.meta.creationCursor).toBe(1); // stops at the unconfirmed creation alert

    // The next REAL run must still have all of it to say.
    const real = await tick(w, state);
    expect(real.telegramConfirmed.every((c) => c === true)).toBe(true);
    const realCrit = real.payload!.criticals.find((c) => c.key === 'm:0')!;
    expect(realCrit.lastDeliveredAt).not.toBe(null);
    expect(realCrit.lastCommandAt).not.toBe(null);
    expect(w.telegram.sent.join('\n')).toContain('cast send'); // the command reached the chat
    expect(w.telegram.sent.join('\n')).toContain('NEW #1'); // and so did the creation alert
    expect(real.payload!.meta.creationCursor).toBe(2); // now it may pass that id
  });

  it('reports itself ineffective rather than claiming a delivered critical', async () => {
    const w = makeWorld();
    w.markets = [closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n)];
    const dry = await tick(w, stateFor('dry-ping'), (d) => ({ ...d, env: { ...d.env, dryRun: true } }));
    // A dry run withheld its criticals, so S3 must say so and the ping is /fail.
    expect(dry.ping).toBe('fail');
    expect(dry.s3Reasons).toContain('critical undelivered');
  });
});

// MINOR: readEnv threw OUTSIDE runGuarded, so a malformed provider URL made no
// request at all and the only signal was the dead-man check timing out.
describe('a configuration failure reports immediately', () => {
  it('pings /fail naming the variable, using only the Healthchecks URL', async () => {
    const w = makeWorld();
    const logs: string[] = [];
    const mod = await import('../src/index');
    const badEnv = {
      WATCHDOG_STATE: env.WATCHDOG_STATE,
      MAKO_ADDRESS: '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
      RESOLVER_ADDRESS: '0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1',
      PUBLIC_RPC_URL: 'https://testnet-rpc.monad.xyz/',
      APP_URL: 'https://makomarket.xyz',
      // The same origin as the public RPC: a real misconfiguration, and one
      // readEnv names in its message.
      PROVIDER_B_URL: 'https://testnet-rpc.monad.xyz/',
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_CHAT_ID: '1',
      HEALTHCHECKS_PING_URL: HC,
    } as unknown as Parameters<typeof mod.readEnv>[0];
    expect(() => mod.readEnv(badEnv)).toThrow();

    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} };
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeDeps(w, { acquire: async () => ({ ok: false, reason: 'lease_held' }), commit: async () => ({ ok: true }) }, logs).fetch;
    try {
      await mod.default.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry: () => {} } as unknown as ScheduledController, badEnv, ctx as unknown as ExecutionContext);
      await Promise.all(waits);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(w.hc.pings).toHaveLength(1);
    expect(w.hc.pings[0].url).toMatch(/\/fail$/);
    expect(w.hc.pings[0].body).toContain('configuration rejected');
    expect(w.hc.pings[0].body).toContain('PROVIDER_B_URL');
  });
});
