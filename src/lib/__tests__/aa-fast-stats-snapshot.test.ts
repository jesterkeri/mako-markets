// /api/cron/aa-fast refreshes the /stats account figures on its own database wake-up (Joshua, 2026-10-09): first, once
// per run, and a failure never stops the cleanup that follows; it is logged as a code, never a message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ order: [] as string[], refresh: vi.fn() }));
vi.mock('@/lib/stats-snapshot-refresh', () => ({ refreshDbSnapshot: m.refresh }));
vi.mock('@/lib/aa-pending-user-ops', () => ({
  AlreadyClaimedError: class extends Error {},
  expirePastDueRows: vi.fn(async () => (m.order.push('expire'), 0)),
  selectStaleSendingRows: vi.fn(async () => (m.order.push('select'), [])),
  transitionFromSendingViaResolver: vi.fn(),
}));
vi.mock('@/lib/user-op', () => ({ resolveSubmittedOp: vi.fn() }));

const SECRET = 'a-test-cron-secret-of-enough-length';
const req = () => new Request('http://localhost/api/cron/aa-fast', { headers: { authorization: `Bearer ${SECRET}` } });

let errors: string[] = [];
beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  m.order = [];
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  m.refresh.mockReset();
});

describe('aa-fast and the stats figures', () => {
  it('refreshes them once, before the cleanup', async () => {
    m.refresh.mockImplementation(async () => (m.order.push('stats'), { readAt: 1 }));
    const { GET } = await import('@/app/api/cron/aa-fast/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(m.order).toEqual(['stats', 'expire', 'select']);
  });

  it('a failed refresh is logged by code and the cleanup still runs', async () => {
    m.refresh.mockRejectedValue(Object.assign(new Error('connect failed postgres://u:SENTINEL@h/db'), { code: 'ECONNREFUSED' }));
    const { GET } = await import('@/app/api/cron/aa-fast/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(m.order).toEqual(['expire', 'select']);
    expect(errors.join('\n')).toContain('ECONNREFUSED');
    expect(errors.join('\n')).not.toContain('SENTINEL');
  });

  it('a refresh that never finishes holds the cleanup for its 14 s budget at most', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      m.refresh.mockImplementation(() => new Promise(() => {}));
      const { GET } = await import('@/app/api/cron/aa-fast/route');
      const pending = GET(req());
      await vi.advanceTimersByTimeAsync(13_999);
      expect(m.order, 'still inside the budget').toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe(200);
      expect(m.order).toEqual(['expire', 'select']);
      expect(errors.join('\n')).toContain('TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unauthenticated call refreshes nothing', async () => {
    const { GET } = await import('@/app/api/cron/aa-fast/route');
    const res = await GET(new Request('http://localhost/api/cron/aa-fast'));
    expect(res.status).toBe(403);
    expect(m.refresh).not.toHaveBeenCalled();
  });
});
