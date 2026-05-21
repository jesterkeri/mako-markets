// ----------------------------------------------------------------------------
// src/lib/__tests__/api-mako-labels-route.test.ts
//
// Route-level test for GET /api/mako-labels, the public batch read for
// MAKO outcome labels. Verifies the status-code surface called out in
// the Group A codex review (no auth, empty input shortcut, 100-id cap,
// DAO unwrap to array). DAO is mocked via vi.hoisted; no pglite needed
// for this surface.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMakoLabelsBatch: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {},
}));
vi.mock('@/lib/mako-labels-server', () => ({
  getMakoLabelsBatch: (...args: unknown[]) => mocks.getMakoLabelsBatch(...args),
}));

import { GET } from '@/app/api/mako-labels/route';

afterEach(() => {
  mocks.getMakoLabelsBatch.mockReset();
});

function reqWith(qs: string): Request {
  return new Request(`http://localhost/api/mako-labels${qs}`);
}

describe('GET /api/mako-labels', () => {
  it('returns 200 + empty labels and skips the DAO when no ids param is given', async () => {
    const res = await GET(reqWith(''));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ labels: [] });
    expect(mocks.getMakoLabelsBatch).not.toHaveBeenCalled();
  });

  it('returns 200 + empty labels and skips the DAO when ids= is empty', async () => {
    const res = await GET(reqWith('?ids='));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ labels: [] });
    expect(mocks.getMakoLabelsBatch).not.toHaveBeenCalled();
  });

  it('returns 400 when more than 100 ids are passed', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i + 1)).join(',');
    const res = await GET(reqWith(`?ids=${ids}`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('too_many_ids');
    expect(body.max).toBe(100);
    expect(mocks.getMakoLabelsBatch).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 ids (boundary)', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(i + 1)).join(',');
    mocks.getMakoLabelsBatch.mockResolvedValue(new Map());
    const res = await GET(reqWith(`?ids=${ids}`));
    expect(res.status).toBe(200);
    expect(mocks.getMakoLabelsBatch).toHaveBeenCalledOnce();
    /// Confirm the route forwarded all 100 ids to the DAO (string array).
    const call = mocks.getMakoLabelsBatch.mock.calls[0];
    expect((call[1] as string[]).length).toBe(100);
  });

  it('unwraps a DAO Map into the labels array shape', async () => {
    mocks.getMakoLabelsBatch.mockResolvedValue(
      new Map([
        ['1', { label1: 'APC', label2: 'PDP' }],
        ['7', { label1: 'YES_CUSTOM', label2: 'NO_CUSTOM' }],
      ]),
    );
    const res = await GET(reqWith('?ids=1,7,999'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      labels: Array<{ marketId: string; label1: string; label2: string }>;
    };
    /// Order isn't guaranteed by Map iteration order across pglite + JS
    /// runtimes, so sort before asserting.
    const sorted = [...body.labels].sort((a, b) =>
      a.marketId.localeCompare(b.marketId),
    );
    expect(sorted).toEqual([
      { marketId: '1', label1: 'APC', label2: 'PDP' },
      { marketId: '7', label1: 'YES_CUSTOM', label2: 'NO_CUSTOM' },
    ]);
    /// 999 had no DB row; absent from the response. Client falls back
    /// to YES/NO via the read-side helper.
  });

  it('trims whitespace + drops blank entries before counting + before DAO call', async () => {
    mocks.getMakoLabelsBatch.mockResolvedValue(new Map());
    const res = await GET(reqWith('?ids=%20,%20%202%20,,5'));
    expect(res.status).toBe(200);
    expect(mocks.getMakoLabelsBatch).toHaveBeenCalledOnce();
    const ids = mocks.getMakoLabelsBatch.mock.calls[0][1] as string[];
    expect(ids).toEqual(['2', '5']);
  });

  it('returns 500 if the DAO throws (defense — unexpected DB error)', async () => {
    mocks.getMakoLabelsBatch.mockRejectedValue(new Error('connection lost'));
    const res = await GET(reqWith('?ids=1'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('read_failed');
    expect(body.message).toBe('connection lost');
  });
});
