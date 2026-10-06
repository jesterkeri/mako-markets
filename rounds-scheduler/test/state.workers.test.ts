// The real SchedulerState Durable Object: one holder at a time; a holder that lost the lease cannot release it.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { LEASE_MS, SEND_MARGIN_MS } from '../src/state';

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

  it('confirms a send only for the holder, and only with SEND_MARGIN_MS left (Codex Rounds r2)', async () => {
    const s = stub('confirm');
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    expect(await s.confirm(a.token, LEASE_MS - SEND_MARGIN_MS)).toEqual({ ok: true, expiresAt: LEASE_MS });
    expect(await s.confirm(a.token, LEASE_MS - SEND_MARGIN_MS + 1)).toEqual({ ok: false });
    expect(await s.confirm(a.token + 1, 0)).toEqual({ ok: false });
    // Expired and taken by B: A's confirm fails even at a time A thinks is early; B's succeeds.
    const b = await s.acquire(LEASE_MS);
    if (!b.ok) throw new Error('no lease for b');
    expect(await s.confirm(a.token, 0)).toEqual({ ok: false });
    expect(await s.confirm(b.token, LEASE_MS + 1)).toEqual({ ok: true, expiresAt: 2 * LEASE_MS });
    // Released: nobody confirms.
    await s.release(b.token);
    expect(await s.confirm(b.token, LEASE_MS + 1)).toEqual({ ok: false });
  });
});
