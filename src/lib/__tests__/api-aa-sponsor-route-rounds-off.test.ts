// /api/aa/sponsor while Rounds is not live: every Rounds kind answers 503 round_unavailable and nothing is built,
// counted or read from chain.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address } from 'viem';

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS;
});

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  selectFromUserSafes: vi.fn(),
  incrementOrReject: vi.fn(),
  buildSponsoredUserOp: vi.fn(),
  getBlock: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: () => mocks.getUserSession() }));
vi.mock('@/db/client', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.selectFromUserSafes() }) }) }) },
}));
vi.mock('@/lib/aa-pending-user-ops', () => ({ loadInFlightForSafe: async () => null, insertPending: vi.fn() }));
vi.mock('@/lib/aa-sponsor-limits', () => ({ incrementOrReject: (a: unknown) => mocks.incrementOrReject(a), decrementForRefund: vi.fn() }));
vi.mock('@/lib/user-op', () => ({ buildSponsoredUserOp: (a: unknown) => mocks.buildSponsoredUserOp(a) }));
vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({ getBlock: (a: unknown) => mocks.getBlock(a), readContract: (a: unknown) => mocks.readContract(a) }),
}));

import { POST } from '../../app/api/aa/sponsor/route';
import { roundsAbi } from '../rounds-abi';

const SOME: Address = '0x5e0f1e7b7a3b1c2d3E4F5a6b7c8D9E0f1A2B3C4d';
const enter = encodeFunctionData({ abi: roundsAbi, functionName: 'enter', args: [7n, 1, 100_000n] });
const schedule = encodeFunctionData({ abi: roundsAbi, functionName: 'schedule', args: [1_790_000_700n] });

afterEach(() => {
  vi.clearAllMocks();
});

describe('/api/aa/sponsor — Rounds not live', () => {
  it.each([
    ['round_enter', enter],
    ['round_claim', enter],
    ['round_refund', enter],
    ['round_schedule', schedule],
  ])('%s answers 503 round_unavailable and touches nothing', async (kind, data) => {
    mocks.getUserSession.mockResolvedValue({ userId: 'u', email: 'a@b.com', magicEoa: '0x2222222222222222222222222222222222222222', sessionId: 's' });
    mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: '0x1111111111111111111111111111111111111111' }]);
    mocks.getBlock.mockResolvedValue({ timestamp: 1_790_000_000n });
    const res = await POST(
      new Request('http://localhost/api/aa/sponsor', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ kind, chainId: 10143, call: { to: SOME, value: '0x0', data } }),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'round_unavailable' });
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.getBlock).not.toHaveBeenCalled();
  });
});
