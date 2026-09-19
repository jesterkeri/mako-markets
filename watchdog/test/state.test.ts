import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
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

describe('lease (I6)', () => {
  it('starts empty with the initial meta', async () => {
    const s = stub();
    const a = await s.acquire(T0, T0);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.snapshot.token).toBe(1);
    expect(a.snapshot.meta).toEqual(INITIAL_META);
    expect(a.snapshot.auditQueueSize).toBe(0);
  });

  it('A holds the lease, B is skipped', async () => {
    const s = stub();
    expect((await s.acquire(T0, T0)).ok).toBe(true);
    expect(await s.acquire(T0 + 300_000, T0 + 100_000)).toEqual({ ok: false, reason: 'lease_held' });
  });

  it('A passes 270 s: B gets token + 1 and A cannot commit', async () => {
    const s = stub();
    const a = await s.acquire(T0, T0);
    if (!a.ok) throw new Error('A');
    const b = await s.acquire(T0 + 300_000, T0 + 270_000);
    if (!b.ok) throw new Error('B');
    expect(b.snapshot.token).toBe(a.snapshot.token + 1);
    expect(await s.commit(a.snapshot.token, T0, payload(a.snapshot, 5))).toEqual({ ok: false, reason: 'fenced' });
    expect(await s.commit(b.snapshot.token, T0 + 300_000, payload(b.snapshot, 7))).toEqual({ ok: true });
    const c = await s.acquire(T0 + 600_000, T0 + 600_000);
    if (!c.ok) throw new Error('C');
    expect(c.snapshot.meta.creationCursor).toBe(7);
  });

  it('1 ms before expiry the lease still holds', async () => {
    const s = stub();
    await s.acquire(T0, T0);
    expect((await s.acquire(T0 + 300_000, T0 + 270_000 - 1)).ok).toBe(false);
  });

  it('duplicate, out-of-order and late events cannot acquire', async () => {
    const s = stub();
    const a = await s.acquire(T0, T0);
    if (!a.ok) throw new Error('A');
    expect((await s.commit(a.snapshot.token, T0, payload(a.snapshot, 1))).ok).toBe(true);
    expect(await s.acquire(T0, T0 + 1000)).toEqual({ ok: false, reason: 'not_newer' }); // duplicate
    expect(await s.acquire(T0 - 300_000, T0 + 1000)).toEqual({ ok: false, reason: 'not_newer' }); // late
    expect((await s.acquire(T0 + 300_000, T0 + 300_000)).ok).toBe(true);
  });

  it('a stale snapshot cannot overwrite a newer commit (reversed completion)', async () => {
    const s = stub();
    const a = await s.acquire(T0, T0);
    if (!a.ok) throw new Error('A');
    const b = await s.acquire(T0 + 300_000, T0 + 280_000);
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
    const a = await s.acquire(T0, T0);
    if (!a.ok) throw new Error('A');
    expect((await s.commit(a.snapshot.token, T0, payload(a.snapshot, 1))).ok).toBe(true);
    expect((await s.commit(a.snapshot.token, T0, payload(a.snapshot, 2))).ok).toBe(false);
  });

  it('a commit must carry the scheduledTime its lease was acquired for', async () => {
    const s = stub();
    const a = await s.acquire(T0, T0);
    if (!a.ok) throw new Error('A');
    expect(await s.commit(a.snapshot.token, T0 + 300_000, payload(a.snapshot, 1))).toEqual({ ok: false, reason: 'fenced' });
  });
});

describe('state round trip', () => {
  it('stores every table and appends the audit queue exactly once', async () => {
    const s = stub();
    const a = await s.acquire(T0, T0);
    if (!a.ok) throw new Error('A');
    const p = payload(a.snapshot, 86, {
      checks: [{ code: 'nc', state: 'fail', since: T0, observed: 'fail', streak: 0, detail: 'comments API: http 500' }],
      criticals: [{ key: 'm:78', since: T0, lastDeliveredAt: null, line: '#78 ...', marketId: 78, code: null, lastCommandAt: T0 }],
      warnings: [{ key: 'bal', since: T0, deliveredAt: T0, line: 'low', lastCommandAt: null }],
      notes: [{ key: 'bootstrap', createdAt: T0, text: 'started' }],
      resolvedBits: 'ff01',
      auditAppend: [{ marketId: 90, block: 5, discoveredAt: T0 }],
    });
    expect((await s.commit(a.snapshot.token, T0, p)).ok).toBe(true);
    const b = await s.acquire(T0 + 300_000, T0 + 300_000);
    if (!b.ok) throw new Error('B');
    expect(b.snapshot.checks).toEqual(p.checks);
    expect(b.snapshot.criticals).toEqual(p.criticals);
    expect(b.snapshot.warnings).toEqual(p.warnings);
    expect(b.snapshot.notes).toEqual(p.notes);
    expect(b.snapshot.resolvedBits).toBe('ff01');
    expect(b.snapshot.auditQueueSize).toBe(1);
    // The same id again (it cannot happen: the bit is set in the same commit) is ignored.
    expect((await s.commit(b.snapshot.token, T0 + 300_000, { ...payload(b.snapshot, 86), auditAppend: [{ marketId: 90, block: 6, discoveredAt: T0 + 300_000 }] })).ok).toBe(true);
    const c = await s.acquire(T0 + 600_000, T0 + 600_000);
    if (!c.ok) throw new Error('C');
    expect(c.snapshot.auditQueueSize).toBe(1);
  });
});
