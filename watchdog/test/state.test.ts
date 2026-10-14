import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { LEASE_MS } from '../src/config';
import { INITIAL_META, type CommitPayload, type Snapshot } from '../src/state';

// Each test uses its own object name: storage persists within a file.
let n = 0;
function stub() {
  return env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName(`state-test-${n++}`));
}

function payload(snap: Snapshot, cursor: number, extra: Partial<CommitPayload> = {}): CommitPayload {
  return {
    meta: { ...snap.meta, creationCursor: cursor },
    checks: snap.checks,
    criticals: snap.criticals,
    warnings: snap.warnings,
    notes: snap.notes,
    resolvedBits: snap.resolvedBits,
    auditAppend: [],
    ...extra,
  };
}

const T0 = 1_790_000_000_000;

/// Time passing, for the one clock a test cannot set. Lease expiry is the
/// Durable Object's OWN clock (`src/state.ts`), so a test moves the stored
/// expiry rather than pretending to be a caller with a different clock: that
/// pretence is exactly what the lease must ignore.
async function setExpiry(s: ReturnType<typeof stub>, deltaMs: number) {
  await runInDurableObject(s, (_i, st) => {
    st.storage.sql.exec('UPDATE lease SET expires_at = ? WHERE id = 1', Date.now() + deltaMs);
  });
}

describe('lease (I6)', () => {
  it('starts empty with the initial meta', async () => {
    const s = stub();
    const a = await s.acquire(T0);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.snapshot.token).toBe(1);
    expect(a.snapshot.meta).toEqual(INITIAL_META);
    expect(a.snapshot.auditQueueSize).toBe(0);
  });

  it('A holds the lease, B is skipped', async () => {
    const s = stub();
    expect((await s.acquire(T0)).ok).toBe(true);
    expect(await s.acquire(T0 + 100_000)).toEqual({ ok: false, reason: 'lease_held' });
    // The NEXT CRON TICK is 300 s of scheduled time later, past the 270 s
    // expiry, and must still be refused while the holder is alive: a late
    // event (r15 section 7) can arrive while the previous run is mid-delivery.
    expect(await s.acquire(T0 + 300_000)).toEqual({ ok: false, reason: 'lease_held' });
    expect(await s.acquire(T0 + 10 * 300_000)).toEqual({ ok: false, reason: 'lease_held' });
  });

  it('the stored expiry comes from this object clock, not from the scheduled time', async () => {
    const s = stub();
    const far = T0 + 365 * 24 * 3600_000; // a scheduled time a year out
    expect((await s.acquire(far)).ok).toBe(true);
    await runInDurableObject(s, (_i, st) => {
      const row = st.storage.sql.exec<{ expires_at: number; scheduled_time: number }>('SELECT expires_at, scheduled_time FROM lease').one();
      expect(row.scheduled_time).toBe(far); // kept, for commit fencing
      expect(Math.abs(row.expires_at - (Date.now() + LEASE_MS))).toBeLessThan(5_000);
    });
  });

  it('A passes 270 s: B gets token + 1 and A cannot commit', async () => {
    const s = stub();
    const a = await s.acquire(T0);
    if (!a.ok) throw new Error('A');
    await setExpiry(s, 0); // A's lease has run out
    const b = await s.acquire(T0 + 300_000);
    if (!b.ok) throw new Error('B');
    expect(b.snapshot.token).toBe(a.snapshot.token + 1);
    expect(await s.commit(a.snapshot.token, T0, payload(a.snapshot, 5))).toEqual({ ok: false, reason: 'fenced' });
    expect(await s.commit(b.snapshot.token, T0 + 300_000, payload(b.snapshot, 7))).toEqual({ ok: true });
    const c = await s.acquire(T0 + 600_000);
    if (!c.ok) throw new Error('C');
    expect(c.snapshot.meta.creationCursor).toBe(7);
  });

  it('before expiry the lease holds; at expiry it frees', async () => {
    const s = stub();
    await s.acquire(T0);
    await setExpiry(s, 5_000);
    expect(await s.acquire(T0 + 300_000)).toEqual({ ok: false, reason: 'lease_held' });
    await setExpiry(s, 0);
    expect((await s.acquire(T0 + 300_000)).ok).toBe(true);
  });

  it('duplicate, out-of-order and late events cannot acquire', async () => {
    const s = stub();
    const a = await s.acquire(T0);
    if (!a.ok) throw new Error('A');
    expect((await s.commit(a.snapshot.token, T0, payload(a.snapshot, 1))).ok).toBe(true);
    expect(await s.acquire(T0)).toEqual({ ok: false, reason: 'not_newer' }); // duplicate
    expect(await s.acquire(T0 - 300_000)).toEqual({ ok: false, reason: 'not_newer' }); // late
    expect((await s.acquire(T0 + 300_000)).ok).toBe(true);
  });

  it('a stale snapshot cannot overwrite a newer commit (reversed completion)', async () => {
    const s = stub();
    const a = await s.acquire(T0);
    if (!a.ok) throw new Error('A');
    await setExpiry(s, 0); // A stopped without committing
    const b = await s.acquire(T0 + 300_000);
    if (!b.ok) throw new Error('B');
    // B (later token) commits first; A's stale commit is rejected.
    expect((await s.commit(b.snapshot.token, T0 + 300_000, payload(b.snapshot, 9))).ok).toBe(true);
    expect((await s.commit(a.snapshot.token, T0, payload(a.snapshot, 1))).ok).toBe(false);
    await runInDurableObject(s, async (_i, state) => {
      const meta = JSON.parse(state.storage.sql.exec<{ json: string }>('SELECT json FROM meta').one().json);
      expect(meta.creationCursor).toBe(9);
    });
  });

  it('a double commit with the same token is rejected', async () => {
    const s = stub();
    const a = await s.acquire(T0);
    if (!a.ok) throw new Error('A');
    expect((await s.commit(a.snapshot.token, T0, payload(a.snapshot, 1))).ok).toBe(true);
    expect((await s.commit(a.snapshot.token, T0, payload(a.snapshot, 2))).ok).toBe(false);
  });

  it('a commit must carry the scheduledTime its lease was acquired for', async () => {
    const s = stub();
    const a = await s.acquire(T0);
    if (!a.ok) throw new Error('A');
    expect(await s.commit(a.snapshot.token, T0 + 300_000, payload(a.snapshot, 1))).toEqual({ ok: false, reason: 'fenced' });
  });
});

describe('state round trip', () => {
  it('stores every table and appends the audit queue exactly once', async () => {
    const s = stub();
    const a = await s.acquire(T0);
    if (!a.ok) throw new Error('A');
    const p = payload(a.snapshot, 86, {
      checks: [{ code: 'nc', state: 'fail', since: T0, observed: 'fail', streak: 0, detail: 'comments API: http 500' }],
      criticals: [{ key: 'm:78', since: T0, lastDeliveredAt: null, line: '#78 ...', condition: '#78 ...', confirmedAt: T0, marketId: 78, code: null, lastCommandAt: T0 }],
      warnings: [{ key: 'bal', since: T0, deliveredAt: T0, line: 'low', condition: null, confirmedAt: null, lastCommandAt: null }],
      notes: [{ key: 'bootstrap', createdAt: T0, text: 'started' }],
      resolvedBits: 'ff01',
      auditAppend: [{ marketId: 90, block: 5, discoveredAt: T0 }],
    });
    expect((await s.commit(a.snapshot.token, T0, p)).ok).toBe(true);
    const b = await s.acquire(T0 + 300_000);
    if (!b.ok) throw new Error('B');
    expect(b.snapshot.checks).toEqual(p.checks);
    expect(b.snapshot.criticals).toEqual(p.criticals);
    expect(b.snapshot.warnings).toEqual(p.warnings);
    expect(b.snapshot.notes).toEqual(p.notes);
    expect(b.snapshot.resolvedBits).toBe('ff01');
    expect(b.snapshot.auditQueueSize).toBe(1);
    // The same id again (it cannot happen: the bit is set in the same commit) is ignored.
    expect((await s.commit(b.snapshot.token, T0 + 300_000, { ...payload(b.snapshot, 86), auditAppend: [{ marketId: 90, block: 6, discoveredAt: T0 + 300_000 }] })).ok).toBe(true);
    const c = await s.acquire(T0 + 600_000);
    if (!c.ok) throw new Error('C');
    expect(c.snapshot.auditQueueSize).toBe(1);
  });
});
