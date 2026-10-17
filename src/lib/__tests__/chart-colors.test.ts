// Candle colours (Joshua 2026-10-17): TradingView's full set, TradingView's green and red by default, saved to the
// account through /api/user/chart-colors.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHART_COLORS, parseChartColors } from '../chart-colors';

const SIX = { upBody: '#26A69A', downBody: '#ef5350', upBorder: '#000000', downBorder: '#ffffff', upWick: '#123456', downWick: '#abcdef' };

describe('parseChartColors', () => {
  it('six #rrggbb colours, lower-cased', () => {
    expect(parseChartColors(SIX)).toEqual({ ...SIX, upBody: '#26a69a' });
  });
  it('anything else is null: missing or extra keys, short hex, names, arrays, null', () => {
    const { upWick: _w, ...five } = SIX;
    for (const bad of [five, { ...SIX, extra: '#000000' }, { ...SIX, upBody: '#fff' }, { ...SIX, upBody: 'red' }, { ...SIX, upBody: 1 }, [], null, 'x'])
      expect(parseChartColors(bad), JSON.stringify(bad)).toBeNull();
  });
  it("defaults are TradingView's green #26a69a and red #ef5350 for body, border and wick", () => {
    expect(DEFAULT_CHART_COLORS).toEqual({ upBody: '#26a69a', downBody: '#ef5350', upBorder: '#26a69a', downBorder: '#ef5350', upWick: '#26a69a', downWick: '#ef5350' });
    expect(parseChartColors(DEFAULT_CHART_COLORS)).toEqual(DEFAULT_CHART_COLORS);
  });
});

describe('candle series options', () => {
  it('each colour lands on its own option (no up/down or part swap)', async () => {
    vi.doMock('lightweight-charts', () => ({ createChart: vi.fn(), CrosshairMode: {}, ColorType: {}, LineStyle: {} }));
    const { candleOptions } = await import('@/components/chart/ChartInner');
    expect(candleOptions(parseChartColors(SIX)!)).toEqual({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#000000',
      borderDownColor: '#ffffff',
      wickUpColor: '#123456',
      wickDownColor: '#abcdef',
    });
  });
});

const mocks = vi.hoisted(() => ({ session: vi.fn(), sameOrigin: vi.fn(() => ({ ok: true })), stored: vi.fn(), set: vi.fn(), returning: vi.fn() }));
vi.mock('@/lib/user-session', () => ({ getUserSession: mocks.session }));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: mocks.sameOrigin }));
vi.mock('@/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.stored() }) }) }),
    update: () => ({ set: (v: unknown) => (mocks.set(v), { where: () => ({ returning: () => mocks.returning() }) }) }),
  },
}));
afterEach(() => vi.clearAllMocks());

const ACC = '0x00000000000000000000000000000000000000a1';
const post = (body: unknown) => new Request('http://localhost/api/user/chart-colors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('/api/user/chart-colors', () => {
  it('signed out: 401 on GET and POST, nothing written', async () => {
    mocks.session.mockResolvedValue(null);
    const { GET, POST } = await import('@/app/api/user/chart-colors/route');
    expect((await GET()).status).toBe(401);
    expect((await POST(post({ account: ACC, colors: SIX }))).status).toBe(401);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('GET: the stored set, or null for none or a malformed stored value', async () => {
    mocks.session.mockResolvedValue({ userId: 'u1' });
    const { GET } = await import('@/app/api/user/chart-colors/route');
    mocks.stored.mockResolvedValueOnce([{ chartColors: SIX }]);
    expect(await (await GET()).json()).toEqual({ colors: { ...SIX, upBody: '#26a69a' } });
    mocks.stored.mockResolvedValueOnce([{ chartColors: null }]);
    expect(await (await GET()).json()).toEqual({ colors: null });
    mocks.stored.mockResolvedValueOnce([{ chartColors: { upBody: 'red' } }]);
    expect(await (await GET()).json()).toEqual({ colors: null });
  });
  it('POST: a valid set is stored lower-cased; null resets; anything else 400 with nothing written; cross-origin 403', async () => {
    mocks.session.mockResolvedValue({ userId: 'u1' });
    mocks.returning.mockResolvedValue([{ id: 'u1' }]);
    const { POST } = await import('@/app/api/user/chart-colors/route');
    expect((await POST(post({ account: ACC, colors: SIX }))).status).toBe(200);
    expect(mocks.set).toHaveBeenLastCalledWith({ chartColors: { ...SIX, upBody: '#26a69a' } });
    expect((await POST(post({ account: ACC, colors: null }))).status).toBe(200);
    expect(mocks.set).toHaveBeenLastCalledWith({ chartColors: null });
    mocks.set.mockClear();
    for (const bad of [{ account: ACC, colors: { upBody: '#000000' } }, { account: ACC }, { account: ACC, colors: 'red' }, { colors: SIX }, { account: 'me', colors: SIX }]) expect((await POST(post(bad))).status, JSON.stringify(bad)).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
    mocks.sameOrigin.mockReturnValueOnce({ ok: false });
    expect((await POST(post({ account: ACC, colors: SIX }))).status).toBe(403);
    mocks.returning.mockResolvedValueOnce([]); // the session is no longer that account
    expect((await POST(post({ account: ACC, colors: SIX }))).status).toBe(409);
  });
});
