// GET /api/names: display names for addresses, public and email-free, with strict input checks.

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveLabels: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/leaderboard/identity', () => ({ resolveLabels: (...a: unknown[]) => mocks.resolveLabels(...a) }));

import { GET } from '@/app/api/names/route';

const A = '0x00000000000000000000000000000000000000Aa';
const B = '0x00000000000000000000000000000000000000bb';
const req = (qs: string) => new Request(`http://localhost/api/names${qs}`);

afterEach(() => mocks.resolveLabels.mockReset());

describe('GET /api/names', () => {
  it('returns names keyed by lowercase address, only for addresses that have one, cached for a minute', async () => {
    mocks.resolveLabels.mockResolvedValue(new Map([[A.toLowerCase(), { displayName: 'dayo', branch: 'safe' }]]));
    const res = await GET(req(`?addresses=${A},${B}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ names: { [A.toLowerCase()]: 'dayo' } });
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(mocks.resolveLabels).toHaveBeenCalledWith({}, [A.toLowerCase(), B.toLowerCase()], 10143);
  });

  it('dedupes addresses case-insensitively before the lookup', async () => {
    mocks.resolveLabels.mockResolvedValue(new Map());
    await GET(req(`?addresses=${A},${A.toLowerCase()}`));
    expect(mocks.resolveLabels.mock.calls[0][1]).toEqual([A.toLowerCase()]);
  });

  it('answers an empty request without touching the database', async () => {
    const res = await GET(req(''));
    expect(await res.json()).toEqual({ names: {} });
    expect(mocks.resolveLabels).not.toHaveBeenCalled();
  });

  it('refuses anything that is not a 20-byte hex address', async () => {
    for (const bad of ['0x123', `${A},nope`, `${A}00`, "0x' OR 1=1 --"]) {
      const res = await GET(req(`?addresses=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_address' });
    }
    expect(mocks.resolveLabels).not.toHaveBeenCalled();
  });

  it('caps a request at 100 distinct addresses', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`).join(',');
    const res = await GET(req(`?addresses=${many}`));
    expect(res.status).toBe(400);
    expect(mocks.resolveLabels).not.toHaveBeenCalled();
  });

  it('fails closed with a bare error and no database detail', async () => {
    mocks.resolveLabels.mockRejectedValue(new Error('connection to db.example refused'));
    const res = await GET(req(`?addresses=${A}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'read_failed' });
  });
});
