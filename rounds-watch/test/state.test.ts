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
