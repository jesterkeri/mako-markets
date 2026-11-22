// CHARTS_DS_PLAN 4.4: the lease statements on a local D1, on D1's own clock. Acquire works on a free, an expired and a
// missing row and never on a live one; the TTL is 90 s; the fence lets a batch commit only while its holder holds an
// unexpired lease (until >= now), and otherwise rolls the whole batch back; release is holder-scoped.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { acquireLease, fence, guardDelete, LEASE_TTL_S, release, stillHeld } from '../src/lease';
import { d1Now, rows } from './tick-helpers';

const db = () => env.DB;
const lease = async () => (await rows('SELECT id, holder, until FROM lease'))[0];
const setLease = (holder: string | null, until: number) => db().prepare('UPDATE lease SET holder = ?1, until = ?2 WHERE id = 1').bind(holder, until).run();
const batchAs = (holder: string, ...writes: D1PreparedStatement[]) => db().batch([fence(db(), holder), ...writes, guardDelete(db()), release(db(), holder)]);

describe('acquire', () => {
  it('takes the seeded free lease (until 0) for 90 s on D1 clock; not a recovery', async () => {
    const before = await d1Now();
    expect(await acquireLease(db(), 'a')).toEqual({ acquired: true, recovered: false });
    const l = await lease();
    const after = await d1Now();
    expect(l.holder).toBe('a');
    expect(LEASE_TTL_S).toBe(90);
    expect(Number(l.until)).toBeGreaterThanOrEqual(before + 90);
    expect(Number(l.until)).toBeLessThanOrEqual(after + 90);
  });

  it('a live lease is busy for everyone, its own holder included', async () => {
    expect((await acquireLease(db(), 'a')).acquired).toBe(true);
    const until = (await lease()).until;
    expect(await acquireLease(db(), 'b')).toEqual({ acquired: false });
    expect(await acquireLease(db(), 'a')).toEqual({ acquired: false });
    expect(await lease()).toEqual({ id: 1, holder: 'a', until });
  });

  it('a lease expiring this very second is still live (taken only when until < now)', async () => {
    // D1's second can turn between the update and the acquire; retry until both run inside one second.
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = await d1Now();
      await setLease('old', now);
      const r = await acquireLease(db(), 'b');
      if (r.acquired && (await d1Now()) !== now) continue;
      expect(r).toEqual({ acquired: false });
      return;
    }
    throw new Error('D1 clock kept turning');
  });

  it('an expired lease never released is taken over and reported as recovered', async () => {
    await setLease('crashed', (await d1Now()) - 1);
    expect(await acquireLease(db(), 'b')).toEqual({ acquired: true, recovered: true });
    expect((await lease()).holder).toBe('b');
  });

  it('a released lease (until 0) is taken without a recovery', async () => {
    await setLease('done', 0);
    expect(await acquireLease(db(), 'b')).toEqual({ acquired: true, recovered: false });
  });

  it('a missing lease row is created by the acquire itself', async () => {
    await db().prepare('DELETE FROM lease').run();
    expect(await acquireLease(db(), 'b')).toEqual({ acquired: true, recovered: false });
    expect((await lease()).holder).toBe('b');
  });

  it('two acquires racing: exactly one wins', async () => {
    const r = await Promise.all(['a', 'b', 'c', 'd'].map((h) => acquireLease(db(), h)));
    expect(r.filter((x) => x.acquired).length).toBe(1);
  });
});

describe('fence and release', () => {
  it('the holder of a live lease commits its batch, which empties lease_guard and releases (until 0)', async () => {
    await acquireLease(db(), 'a');
    await batchAs('a', db().prepare('INSERT INTO runs (t, calls) VALUES (1, 1)'));
    expect(await rows('SELECT t FROM runs')).toEqual([{ t: 1 }]);
    expect(await rows('SELECT * FROM lease_guard')).toEqual([]);
    expect(await lease()).toEqual({ id: 1, holder: 'a', until: 0 });
  });

  it('a batch of another holder is fenced out: nothing written, the lease untouched', async () => {
    await acquireLease(db(), 'a');
    const l = await lease();
    await expect(batchAs('b', db().prepare('INSERT INTO runs (t, calls) VALUES (1, 1)'))).rejects.toThrow();
    expect(await rows('SELECT * FROM runs')).toEqual([]);
    expect(await rows('SELECT * FROM lease_guard')).toEqual([]);
    expect(await lease()).toEqual(l);
    expect(await stillHeld(db(), 'a')).toBe(true);
    expect(await stillHeld(db(), 'b')).toBe(false);
  });

  it('a holder whose lease expired is fenced out even when nobody took it over', async () => {
    await setLease('a', (await d1Now()) - 1);
    await expect(batchAs('a', db().prepare('INSERT INTO runs (t, calls) VALUES (1, 1)'))).rejects.toThrow();
    expect(await rows('SELECT * FROM runs')).toEqual([]);
    expect(await stillHeld(db(), 'a')).toBe(false);
  });

  it('a lease ending this second still commits (until >= now): the slow valid tick of plan 15.2 f', async () => {
    // D1's second can turn between the update and the batch; retry until both run inside one second.
    for (let attempt = 0; attempt < 5; attempt++) {
      await db().prepare('DELETE FROM runs').run();
      const now = await d1Now();
      await setLease('a', now);
      try {
        await batchAs('a', db().prepare('INSERT INTO runs (t, calls) VALUES (1, 1)'));
      } catch {
        if ((await d1Now()) !== now) continue;
        throw new Error('fenced out while until = now');
      }
      expect(await rows('SELECT t FROM runs')).toEqual([{ t: 1 }]);
      return;
    }
    throw new Error('D1 clock kept turning');
  });

  it('a release by a non-holder changes nothing; a holder-less seeded lease is fenced for everyone', async () => {
    await acquireLease(db(), 'a');
    const l = await lease();
    await db().prepare('UPDATE lease SET until = 0 WHERE id = 1 AND holder = ?1').bind('b').run();
    await release(db(), 'b').run();
    expect(await lease()).toEqual(l);
    await setLease(null, (await d1Now()) + 50);
    await expect(batchAs('a')).rejects.toThrow();
  });

  it('a missing lease row fences every batch (COALESCE to 0)', async () => {
    await db().prepare('DELETE FROM lease').run();
    await expect(batchAs('a', db().prepare('INSERT INTO runs (t, calls) VALUES (1, 1)'))).rejects.toThrow();
    expect(await rows('SELECT * FROM runs')).toEqual([]);
  });
});
