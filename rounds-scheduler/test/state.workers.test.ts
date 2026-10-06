// The real SchedulerState Durable Object: one holder at a time; a holder that lost the lease cannot release it.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { LEASE_MS } from '../src/state';

const stub = (name: string) => env.SCHEDULER_STATE.get(env.SCHEDULER_STATE.idFromName(name));

describe('the scheduler lease', () => {
  it('admits one holder until it releases', async () => {
    const s = stub('one');
    const a = await s.acquire(0);
    expect(a.ok).toBe(true);
    expect((await s.acquire(1)).ok).toBe(false);
    if (!a.ok) throw new Error('no lease');
    expect(await s.release(a.token)).toEqual({ ok: true });
    expect((await s.acquire(2)).ok).toBe(true);
  });

  it('frees itself when a run dies holding it, and the dead run can no longer release it', async () => {
    const s = stub('expired');
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    const b = await s.acquire(LEASE_MS);
    expect(b.ok).toBe(true);
    expect(await s.release(a.token)).toEqual({ ok: false });
    expect((await s.acquire(LEASE_MS + 1)).ok).toBe(false);
  });
});
