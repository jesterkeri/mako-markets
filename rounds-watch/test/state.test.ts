// The real WatchState Durable Object: one holder at a time, and a holder that lost the lease cannot write.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LEASE_MS } from '../src/state';

const stub = (name: string) => env.WATCH_STATE.get(env.WATCH_STATE.idFromName(name));

describe('the watch lease', () => {
  it('admits one holder until it commits or expires', async () => {
    const s = stub('one');
    const a = await s.acquire(0);
    expect(a.ok).toBe(true);
    expect((await s.acquire(1)).ok).toBe(false);
    if (!a.ok) throw new Error('no lease');
    expect(await s.commit(a.token, a.meta, 2)).toEqual({ ok: true });
    expect((await s.acquire(3)).ok).toBe(true);
  });

  it('a holder whose lease was taken cannot commit', async () => {
    const s = stub('fenced');
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    const b = await s.acquire(LEASE_MS);
    expect(b.ok).toBe(true);
    expect(await s.commit(a.token, a.meta, LEASE_MS + 1)).toEqual({ ok: false });
  });
});

// Codex T2.0d r4: the Healthchecks page cursor moves only by compare-and-set, after a page was accepted.
describe('the Healthchecks page cursor', () => {
  it('moves only from where the accepted page began', async () => {
    const s = stub('hc-cursor');
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    expect(await s.commit(a.token, { ...a.meta, hcCursor: 5 }, 1)).toEqual({ ok: true });
    expect(await s.advanceHcCursor(4, 9)).toEqual({ ok: false });
    expect(await s.advanceHcCursor(5, 9)).toEqual({ ok: true });
    expect(await s.advanceHcCursor(5, 12)).toEqual({ ok: false });
    const b = await s.acquire(2);
    if (!b.ok) throw new Error('no lease');
    expect(b.meta.hcCursor).toBe(9);
  });
});
