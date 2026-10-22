import { pingBetaSweep, type Env } from './sweep';

// mako-beta-sweep: fires beta's avatar sweep every 15 minutes, as the main worker does for production (owner decisions
// Q-J and Q-L, 2026-10-19). No fetch handler and no workers.dev route: nothing can call it from outside.
const worker = {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      // Wrapped, never the detached global (Workers throws "Illegal invocation" on a detached fetch).
      pingBetaSweep(env, (input, init) => fetch(input, init)).then((o) => {
        if (o.ok) {
          if (!o.summary.complete) console.error('[beta-sweep] backlog left after the time budget', o.summary);
          else console.log('[beta-sweep] ok', o.summary);
        } else {
          console.error('[beta-sweep] failed', o.reason, o.status ?? '');
        }
      }),
    );
  },
};

export default worker;
