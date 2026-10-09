// The /stats account figures file (src/lib/stats-snapshot.ts, Codex RELEASE_R9 #1): written only by the 15-minute job,
// one file per environment so beta never replaces production's, stamped with the start of its read, and read back
// strictly (anything malformed is no figures, never a zero). No network, no database: Blob and the read are mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ put: vi.fn(), read: vi.fn() }));
vi.mock('@vercel/blob', () => ({ put: m.put }));
vi.mock('@/lib/stats-db-read', () => ({ readDbFigures: m.read }));

import { fetchDbSnapshot, parseSnapshot, refreshDbSnapshot, snapshotPathname } from '../stats-snapshot';

const FIGURES = { gasFree: { actions: 74, accounts: 11 }, makoWallets: 19 };
const T0 = new Date('2026-10-09T12:00:00Z').getTime();
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  m.put.mockResolvedValue({});
  m.read.mockResolvedValue(FIGURES);
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_StoreABC_notasecret');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  globalThis.fetch = realFetch;
});

describe('which file', () => {
  it('production, beta and development each have their own; anything unknown is development', () => {
    expect(snapshotPathname('production')).toBe('stats/production/db-figures.json');
    expect(snapshotPathname('preview')).toBe('stats/preview/db-figures.json');
    expect(snapshotPathname('development')).toBe('stats/development/db-figures.json');
    expect(snapshotPathname(undefined)).toBe('stats/development/db-figures.json');
    expect(snapshotPathname('Production')).toBe('stats/development/db-figures.json');
  });
});

describe('refreshDbSnapshot (the scheduled job)', () => {
  it('writes this environment’s file, public, overwritten in place, cached at most a minute', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    await refreshDbSnapshot();
    expect(m.put).toHaveBeenCalledTimes(1);
    const [path, body, opts] = m.put.mock.calls[0];
    expect(path).toBe('stats/preview/db-figures.json');
    expect(JSON.parse(body)).toEqual({ v: 1, ...FIGURES, readAt: T0 });
    expect(opts).toMatchObject({ access: 'public', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
  });

  it('stamps the time the read STARTED, so the age the page computes is never too young', async () => {
    m.read.mockImplementation(async () => {
      vi.setSystemTime(T0 + 4_000); // the read takes 4 s
      return FIGURES;
    });
    const { readAt } = await refreshDbSnapshot();
    expect(readAt).toBe(T0);
    expect(JSON.parse(m.put.mock.calls[0][1]).readAt).toBe(T0);
  });

  it('a failed read writes nothing, so the old file ages out instead of being refreshed with a guess', async () => {
    m.read.mockRejectedValue(new Error('db down'));
    await expect(refreshDbSnapshot()).rejects.toThrow('db down');
    expect(m.put).not.toHaveBeenCalled();
  });
});

describe('fetchDbSnapshot (the page)', () => {
  const serve = (status: number, body: unknown) => {
    globalThis.fetch = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch;
  };

  it('reads this environment’s file from the store’s public host, uncached, with no token', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    serve(200, { v: 1, ...FIGURES, readAt: T0 - 60_000 });
    expect(await fetchDbSnapshot()).toEqual({ ...FIGURES, readAt: T0 - 60_000 });
    const [url, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('https://storeabc.public.blob.vercel-storage.com/stats/production/db-figures.json');
    expect(init.cache).toBe('no-store');
    expect(JSON.stringify(init)).not.toContain('notasecret');
  });

  it('no store configured, no file yet, an error status or a malformed file: a named failure, never figures', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    await expect(fetchDbSnapshot()).rejects.toMatchObject({ name: 'SnapshotNotConfigured' });
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_StoreABC_notasecret');
    serve(404, 'not found');
    await expect(fetchDbSnapshot()).rejects.toMatchObject({ name: 'SnapshotMissing' });
    serve(503, 'busy');
    await expect(fetchDbSnapshot()).rejects.toMatchObject({ code: 'HTTP_503' });
    serve(200, 'not json');
    await expect(fetchDbSnapshot()).rejects.toMatchObject({ name: 'SnapshotMalformed' });
  });
});

describe('parseSnapshot', () => {
  const good = { v: 1, ...FIGURES, readAt: T0 };
  it.each([
    ['null', null],
    ['wrong version', { ...good, v: 2 }],
    ['negative count', { ...good, makoWallets: -1 }],
    ['fractional count', { ...good, gasFree: { actions: 1.5, accounts: 1 } }],
    ['string count', { ...good, makoWallets: '19' }],
    ['missing gasFree', { v: 1, makoWallets: 19, readAt: T0 }],
    ['readAt in seconds, not ms', { ...good, readAt: Math.floor(T0 / 1000) }],
    ['readAt missing', { v: 1, ...FIGURES }],
  ])('refuses %s', (_name, raw) => {
    expect(parseSnapshot(raw)).toBeNull();
  });
  it('accepts exactly what the job writes', () => {
    expect(parseSnapshot(good)).toEqual({ ...FIGURES, readAt: T0 });
  });
});
