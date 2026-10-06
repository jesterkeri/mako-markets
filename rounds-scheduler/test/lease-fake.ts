// An in-memory stand-in for SchedulerState with the same rules (src/state.ts), for tests that run outside workerd.
import { LEASE_MS, SEND_MARGIN_MS } from '../src/state';
import type { Lease } from '../src/index';
import type { SchedulerState } from '../src/state';

export function memLease(): Lease & { held: () => boolean } {
  let token = 0;
  let held = false;
  let expiresAt = 0;
  return {
    async acquire(now) {
      if (held && expiresAt > now) return { ok: false };
      token += 1;
      held = true;
      expiresAt = now + LEASE_MS;
      return { ok: true, token };
    },
    async release(t) {
      if (t !== token || !held) return { ok: false };
      held = false;
      return { ok: true };
    },
    async confirm(t, now) {
      return t === token && held && expiresAt - now >= SEND_MARGIN_MS ? { ok: true, expiresAt } : { ok: false };
    },
    held: () => held,
  };
}

/// A Durable Object namespace whose one object is `lease`, for calling the Worker's scheduled handler directly.
export function memNamespace(lease: Lease) {
  return { idFromName: () => ({}), get: () => lease } as unknown as DurableObjectNamespace<SchedulerState>;
}

export const deps = (lease: Lease = memLease()) => ({ lease, clockMs: () => Date.now() });
