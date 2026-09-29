// The real KeeperState Durable Object: one lease holder at a time, a lost lease cannot write, and a
// transaction is recorded before it is sent. These are what stop two runs signing with the same nonce.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LEASE_MS, type InFlight } from '../src/state';

const stub = (name: string) => env.KEEPER_STATE.get(env.KEEPER_STATE.idFromName(name));
const tx: InFlight = { hash: '0xabc', nonce: 3, roundId: '1', sentAt: 0 };

describe('the run lease', () => {
  it('admits one holder until it commits or expires', async () => {
    const s = stub('one-holder');
    const a = await s.acquire(1_000);
    expect(a.ok).toBe(true);
    expect((await s.acquire(1_001)).ok).toBe(false);
    expect((await s.acquire(1_000 + LEASE_MS)).ok).toBe(true); // expired: the next run may take it
  });

  it('a holder whose lease was taken cannot commit or record', async () => {
    const s = stub('fenced');
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    const b = await s.acquire(LEASE_MS);
    if (!b.ok) throw new Error('no lease');
    expect(await s.recordInFlight(a.token, tx, LEASE_MS + 1)).toEqual({ ok: false });
    expect(await s.commit(a.token, a.meta, LEASE_MS + 1)).toEqual({ ok: false });
    expect(await s.commit(b.token, b.meta, LEASE_MS + 1)).toEqual({ ok: true });
  });

  it('a holder past its own expiry cannot record a transaction, so it cannot send one', async () => {
    const s = stub('expired-holder');
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    expect(await s.recordInFlight(a.token, tx, LEASE_MS)).toEqual({ ok: false });
  });

  it('a recorded transaction is there for the next run even if this one never commits', async () => {
    const s = stub('crash-after-send');
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    expect(await s.recordInFlight(a.token, tx, 10)).toEqual({ ok: true });
    // no commit: the run crashed after sending
    const next = await s.acquire(LEASE_MS);
    expect(next.ok && next.meta.inFlight).toEqual(tx);
  });

  it('writes the breaker count in the same record as the transaction, so a crash after sending keeps it', async () => {
    const s = stub('breaker-count');
    const a = await s.acquire(0);
    if (!a.ok) throw new Error('no lease');
    expect(await s.recordInFlight(a.token, tx, 10, { poolRefundsSent: [10] })).toEqual({ ok: true });
    // no commit: crashed after sending
    const next = await s.acquire(LEASE_MS);
    expect(next.ok && next.meta.poolRefundsSent).toEqual([10]);
    expect(next.ok && next.meta.inFlight).toEqual(tx);
  });
});
