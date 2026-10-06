// An in-memory stand-in for SchedulerState with the same rules (src/state.ts), for tests that run outside workerd.
import { LEASE_MS, type SendIntent } from '../src/state';
import type { Lease } from '../src/index';
import type { SchedulerState } from '../src/state';

export function memLease(): Lease & { held: () => boolean; openIntent: () => SendIntent | null } {
  let token = 0;
  let held = false;
  let expiresAt = 0;
  let intent: SendIntent | null = null;
  const holds = (t: number, now: number) => t === token && held && expiresAt > now;
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
    async intent(t, now) {
      return holds(t, now) ? { ok: true, intent } : { ok: false };
    },
    async recordIntent(t, now, i) {
      if (!holds(t, now) || intent !== null) return { ok: false };
      intent = i;
      return { ok: true };
    },
    async clearIntent(t, now, hash) {
      if (!holds(t, now) || intent === null || intent.hash !== hash) return { ok: false };
      intent = null;
      return { ok: true };
    },
    held: () => held,
    openIntent: () => intent,
  };
}

/// A Durable Object namespace whose one object is `lease`, for calling the Worker's scheduled handler directly.
export function memNamespace(lease: Lease) {
  return { idFromName: () => ({}), get: () => lease } as unknown as DurableObjectNamespace<SchedulerState>;
}

export const deps = (lease: Lease = memLease()) => ({ lease, clockMs: () => Date.now() });
