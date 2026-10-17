// The live name check's server-side cap (Codex UNIQUE_NAMES R1 M2): a direct burst of distinct names from one account
// is cut off after NAME_CHECKS_PER_MINUTE, before any name query; the store down is a refusal, never unlimited.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), held: vi.fn(), upstash: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/user-session', () => ({ getUserSession: mocks.session }));
vi.mock('@/lib/display-name-holder', () => ({ nameHeldByOther: mocks.held }));
vi.mock('@/lib/envio-budget', () => ({ upstashCommand: mocks.upstash }));

import { NAME_CHECKS_PER_MINUTE } from '@/lib/name-check-budget';
import { GET } from '@/app/api/user/profile/name-available/route';

const ask = (name: string) => GET(new Request(`http://localhost/api/user/profile/name-available?name=${encodeURIComponent(name)}`));

const counts = new Map<string, number>();
beforeEach(() => {
  counts.clear();
  mocks.session.mockResolvedValue({ userId: 'u-1' });
  mocks.held.mockResolvedValue(false);
  // A faithful INCR per key: the script's return value.
  mocks.upstash.mockImplementation(async (args: (string | number)[]) => {
    const key = String(args[3]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts.get(key);
  });
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/user/profile/name-available, per-account cap', () => {
  it('a burst of distinct names: the cap passes, the rest are 429 with no name query', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < NAME_CHECKS_PER_MINUTE + 10; i++) statuses.push((await ask(`Burst${i}`)).status);
    expect(statuses.slice(0, NAME_CHECKS_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(NAME_CHECKS_PER_MINUTE).every((s) => s === 429)).toBe(true);
    expect(mocks.held).toHaveBeenCalledTimes(NAME_CHECKS_PER_MINUTE);
  });

  it('each account has its own budget, and the store never holds the raw account id', async () => {
    for (let i = 0; i < NAME_CHECKS_PER_MINUTE; i++) await ask(`One${i}`);
    expect((await ask('OneMore')).status).toBe(429);
    mocks.session.mockResolvedValue({ userId: 'u-2' });
    expect((await ask('Other')).status).toBe(200);
    for (const key of counts.keys()) expect(key).not.toContain('u-');
  });

  it('the store down or answering nonsense: 503, never an unlimited check', async () => {
    mocks.upstash.mockRejectedValueOnce(new Error('unreachable'));
    expect((await ask('Down')).status).toBe(503);
    mocks.upstash.mockResolvedValueOnce('OK?');
    expect((await ask('Odd')).status).toBe(503);
    expect(mocks.held).not.toHaveBeenCalled();
  });

  it('invalid and reserved names are answered without spending the budget or querying', async () => {
    expect(await (await ask('bad<')).json()).toEqual({ available: false, reason: 'invalid' });
    expect(await (await ask('Mako Official')).json()).toEqual({ available: false, reason: 'reserved' });
    expect(mocks.upstash).not.toHaveBeenCalled();
  });
});
