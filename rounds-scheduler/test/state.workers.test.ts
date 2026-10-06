// The real SchedulerState Durable Object: one holder at a time; a holder that lost the lease cannot release it.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { LEASE_MS, type SendIntent } from '../src/state';

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

  it('records a send intent only for the live holder and only while none is open, and only the holder clears it (Codex Rounds r3)', async () => {
    const s = stub('intent');
    const i1: SendIntent = { house: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', nonce: 4, startTime: 7200, hash: '0x11', raw: '0xaa', recordedAt: 1 };
    const i2: SendIntent = { ...i1, hash: '0x22', raw: '0xbb' };
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    expect(await s.recordIntent(a.token + 1, 1, i1)).toEqual({ ok: false });
    expect(await s.recordIntent(a.token, LEASE_MS, i1)).toEqual({ ok: false }); // expired at LEASE_MS
    expect(await s.recordIntent(a.token, 1, i1)).toEqual({ ok: true });
    expect(await s.recordIntent(a.token, 2, i2)).toEqual({ ok: false }); // one open intent at a time
    expect(await s.intent(a.token, 3)).toEqual({ ok: true, intent: i1 });
    // A's lease runs out; B takes over and sees A's intent; A can no longer read or clear it.
    const b = await s.acquire(LEASE_MS);
    if (!b.ok) throw new Error('no lease for b');
    expect(await s.intent(a.token, LEASE_MS + 1)).toEqual({ ok: false });
    expect(await s.clearIntent(a.token, LEASE_MS + 1, '0x11')).toEqual({ ok: false });
    expect(await s.intent(b.token, LEASE_MS + 1)).toEqual({ ok: true, intent: i1 });
    expect(await s.clearIntent(b.token, LEASE_MS + 1, '0x22')).toEqual({ ok: false }); // only that exact intent
    expect(await s.clearIntent(b.token, LEASE_MS + 1, '0x11')).toEqual({ ok: true });
    expect(await s.intent(b.token, LEASE_MS + 2)).toEqual({ ok: true, intent: null });
    expect(await s.recordIntent(b.token, LEASE_MS + 2, i2)).toEqual({ ok: true });
  });
});
