// A retained critical is re-sent verbatim, so its line can describe a run
// that did not happen. Found by the adversary subagent, 2026-09-21, against
// b15ad78 (review r9).
//
// Reviews r8 and r9 made a stored market critical change only on a head the
// public RPC confirmed at the same finalized block, and r9's fix note asks the
// run to "retain the former truthful line and command schedule while
// confirmation is deferred or unavailable". The line is retained, but it is
// retained as TEXT and re-delivered as a due reminder with nothing marking it
// stale, so the reader is told things that are false at the moment of sending:
//
//   1. "refund command below", although the run withheld the command for want
//      of a second source and the message carries no `cast send` line. This is
//      the mirror image of the harm r9 named: instead of being told his remedy
//      does not exist, Joshua is told it is in a message that does not have
//      it. src/classify.ts:90-91 already holds the honest text for this exact
//      state ("refund command withheld: a second provider did not confirm this
//      market at the same block"), and the retention gate makes it unreachable
//      for every market that already holds a stored critical, which is every
//      market past its first critical run.
//   2. The age. `fmtAge(nowS - closeTime)` is frozen at the last confirmed
//      run, so a market stuck five days is reported as stuck two, understating
//      the thing the alert exists to report, with no word that the line was
//      not checked this run.
//
// Trigger: the ordinary one. The public RPC (testnet-rpc.monad.xyz) stops
// answering. No lying provider is needed; provider B's head is honest
// throughout, and both runs read it.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runOnce, type Deps } from '../src/run';
import { closedMarket, makeDeps, makeWorld, type World } from './fake';

let n = 0;
function freshState(): Deps['state'] {
  const s = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName(`retained-honesty-${n++}`));
  return { acquire: (a) => s.acquire(a), commit: (t, a, p) => s.commit(t, a, p) };
}

const FIVE_MIN = 300_000;
async function tick(w: World, state: Deps['state']) {
  const scheduled = Math.floor(w.clock.t / FIVE_MIN) * FIVE_MIN;
  w.pageRequestIndex = 0;
  w.latestBlock += 600;
  w.finalizedBlock += 600;
  w.finalizedTs = Math.floor(w.clock.t / 1000);
  const r = await runOnce(makeDeps(w, state), scheduled);
  w.clock.t = scheduled + FIVE_MIN + 1_000;
  return r;
}
const nowS = (w: World) => Math.floor(w.clock.t / 1000);

/// Run 1: both sources agree on a one-sided market 2 days past close, so the
/// refund command is offered and delivered and the stored line says so.
/// Run 2, three days later: the public RPC is down, so the command is
/// withheld and the stored row is retained. Returns run 2's messages.
async function reminderAfterThePublicRpcDies(): Promise<{ text: string; body: string }> {
  const w = makeWorld();
  const state = freshState();
  const stuck = closedMarket(1, 'LINK:gt:20', nowS(w), 2 * 86_400, 1_000_000n, 0n);
  w.markets = [stuck];

  const r1 = await tick(w, state);
  expect(w.telegram.sent.join('\n')).toContain('cast send');
  expect(r1.payload!.criticals.find((c) => c.key === 'm:0')!.line).toContain('refund command below');

  w.publicDown = true;
  w.clock.t += 3 * 24 * 3600_000; // the 6-hour reminder is due
  w.telegram.sent = [];
  const r2 = await tick(w, state);
  const text = w.telegram.sent.join('\n');
  expect(text).toContain('#0 CRYPTO'); // the reminder did go out
  expect(text).not.toContain('cast send'); // and the command was withheld
  expect(r2.healthchecksBody).toContain('second source: 0/1 confirmed');
  return { text, body: r2.healthchecksBody };
}

describe('a retained critical line must not describe a run that did not happen', () => {
  it('never says "refund command below" in a message that carries no command', async () => {
    const { text } = await reminderAfterThePublicRpcDies();
    expect(text).not.toContain('refund command below');
  });

  it('either reports the real age or says the market was not confirmed this run', async () => {
    const { text } = await reminderAfterThePublicRpcDies();
    // Three days passed, so "unresolved 2d 0h after close" is the age of the
    // last confirmed run, not of the market. Either figure is defensible as
    // long as the reader can tell which one he is being given.
    const honest = text.includes('unresolved 5d 0h after close') || /not confirmed|unconfirmed|last confirmed|not checked|stale/i.test(text);
    expect(honest, text).toBe(true);
  });
});
