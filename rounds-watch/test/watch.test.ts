// The liveness watch against a fake chain and a fake Data Streams API (N21). Nothing leaves the machine.
//
// What must hold: every two-sided round unsettled 30 minutes after close is flagged, and every NoPrice
// refund, once each, with whether reports existed for both seconds; an honest round is never flagged; an
// alert Telegram did not confirm is retried and also reaches Healthchecks; no secret reaches any output.

import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { REFUND_REASON, STATUS, WATCH_ABI } from '../src/abi';
import { makeNet } from '../src/net';
import { runWatch, UNSETTLED_ALERT_S, type WatchConfig, type WatchDeps } from '../src/run';
import { INITIAL_META, type Meta } from '../src/state';
import fixture from '../../keeper/test/fixtures/fixture-btcusd-1789529160.json';

const RPC = 'https://rpc.test';
const DS = 'https://ds.test';
const SECRET = 'S3CRET-never-print';
const cfg: WatchConfig = {
  roundsAddress: '0x00000000000000000000000000000000000A11CE',
  rpcUrl: RPC,
  datastreamsUrl: DS,
  datastreamsKey: 'APIKEY-never-print',
  datastreamsSecret: SECRET,
};
const C = 1_789_530_060;

interface R {
  start: number;
  status: number;
  reason?: number;
  up: bigint;
  down: bigint;
}

let w: {
  now: number;
  rounds: R[];
  missing: Set<number>;
  telegramOk: boolean;
  messages: string[];
  pings: { kind: string; body: string }[];
  meta: Meta;
  rpcDown: boolean;
  dsRequests: number;
};

function roundResult(r: R) {
  return {
    creator: '0x0000000000000000000000000000000000000C0C' as Hex,
    openTime: BigInt(r.start - 3600),
    startTime: BigInt(r.start),
    status: r.status,
    outcome: 0,
    refundReason: r.reason ?? 0,
    anchorPrice: 0n,
    closePrice: 0n,
    anchorObservedAt: 0,
    closeObservedAt: 0,
    anchorReportHash: ('0x' + '0'.repeat(64)) as Hex,
    closeReportHash: ('0x' + '0'.repeat(64)) as Hex,
    upPool: r.up,
    downPool: r.down,
    upEntrants: 1,
    downEntrants: 1,
    protocolFee: 0n,
    creatorFee: 0n,
    distributable: 0n,
    winnersClaimed: 0,
    paidOut: 0n,
  };
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith(RPC)) {
    if (w.rpcDown) return new Response('down', { status: 503 });
    const calls = JSON.parse(String(init?.body)) as { id: number; params: [{ data: Hex }] }[];
    return Response.json(
      calls.map((c) => {
        const { functionName, args } = decodeFunctionData({ abi: WATCH_ABI, data: c.params[0].data });
        let result: Hex;
        if (functionName === 'roundCount') result = encodeAbiParameters([{ type: 'uint256' }], [BigInt(w.rounds.length)]);
        else if (functionName === 'DURATION') result = encodeAbiParameters([{ type: 'uint64' }], [900n]);
        else result = encodeFunctionResult({ abi: WATCH_ABI, functionName: 'roundOf', result: roundResult(w.rounds[Number(args![0]) - 1]) });
        return { jsonrpc: '2.0', id: c.id, result };
      }),
    );
  }
  if (url.startsWith(DS)) {
    w.dsRequests++;
    const b = Number(new URL(url).searchParams.get('timestamp'));
    if (w.missing.has(b)) return new Response('not found', { status: 404 });
    return Response.json({ report: { feedID: fixture.feedID, validFromTimestamp: b, observationsTimestamp: b, fullReport: fixture.fullReport } });
  }
  throw new Error('unexpected url');
}) as typeof fetch;

function deps(): WatchDeps {
  return {
    net: makeNet(fakeFetch, () => w.now, async () => {}, w.now + 120_000, 14),
    state: {
      acquire: async () => ({ ok: true as const, token: 1, meta: structuredClone(w.meta) }),
      commit: async (_t, m) => {
        w.meta = structuredClone(m);
        return { ok: true };
      },
    },
    hmac: async () => 'ab'.repeat(32),
    telegram: async (text) => {
      w.messages.push(text);
      return w.telegramOk;
    },
    ping: async (kind, body) => {
      w.pings.push({ kind, body });
    },
  };
}

const run = () => runWatch(cfg, deps());
const active = (start: number, up = 1n, down = 1n): R => ({ start, status: STATUS.Active, up, down });

beforeEach(() => {
  w = { now: 0, rounds: [], missing: new Set(), telegramOk: true, messages: [], pings: [], meta: structuredClone(INITIAL_META), rpcDown: false, dsRequests: 0 };
});

const at = (closeTime: number, afterS: number) => (w.now = (closeTime + afterS) * 1000);

describe('unsettled rounds', () => {
  it('flags a two-sided round unsettled 30 minutes after close, once, as a delivery failure when both reports exist', async () => {
    w.rounds = [active(C - 900)];
    at(C, UNSETTLED_ALERT_S - 1);
    expect((await run()).status).toBe('quiet');
    expect(w.messages).toEqual([]);

    at(C, UNSETTLED_ALERT_S);
    const o = await run();
    expect(o.status).toBe('alerting');
    expect(w.messages).toHaveLength(1);
    expect(w.messages[0]).toContain('Round 1 is UNSETTLED 30 min after close');
    expect(w.messages[0]).toContain('DELIVERY failure');
    expect(w.pings.at(-1)?.kind).toBe('fail');

    at(C, UNSETTLED_ALERT_S + 300);
    await run();
    expect(w.messages).toHaveLength(1); // said once
    expect(w.pings.at(-1)?.kind).toBe('fail'); // still in the condition
  });

  it('says when Chainlink has no report for a second, so it will refund whatever anyone does', async () => {
    w.rounds = [active(C - 900)];
    w.missing.add(C);
    at(C, UNSETTLED_ALERT_S);
    await run();
    expect(w.messages[0]).toContain(`close ${new Date(C * 1000).toISOString().replace('.000Z', 'Z')} missing`);
    expect(w.messages[0]).toContain('cannot settle and refunds NoPrice');
  });

  it('never flags an honest round, a one-sided round, or a round before 30 minutes', async () => {
    w.rounds = [
      { start: C - 900, status: STATUS.Settled, up: 1n, down: 1n },
      active(C - 900, 5n, 0n), // one-sided: refunds OneSided by design
      { start: C - 900, status: STATUS.Refunded, reason: REFUND_REASON.Tie, up: 1n, down: 1n },
    ];
    at(C, 3 * 3600);
    expect(await run()).toMatchObject({ status: 'quiet', conditions: [] });
    expect(w.messages).toEqual([]);
    expect(w.pings).toEqual([{ kind: 'ok', body: 'mako-rounds-watch quiet' }]);
  });
});

describe('NoPrice refunds', () => {
  it('flags every NoPrice refund once, with the report state', async () => {
    w.rounds = [{ start: C - 900, status: STATUS.Refunded, reason: REFUND_REASON.NoPrice, up: 1n, down: 1n }];
    at(C, 86_400 + 60);
    await run();
    expect(w.messages[0]).toContain('Round 1 REFUNDED NoPrice');
    expect(w.messages[0]).toMatch(/the Data Streams API returned: start \S+ exists, close \S+ exists\.$/);
    await run();
    expect(w.messages).toHaveLength(1);
  });
});

describe('delivery', () => {
  it('retries an alert Telegram did not confirm, and sends it to Healthchecks meanwhile', async () => {
    w.rounds = [active(C - 900)];
    w.telegramOk = false;
    at(C, UNSETTLED_ALERT_S);
    expect((await run()).status).toBe('telegram-failed');
    expect(w.pings.at(-1)).toMatchObject({ kind: 'fail', body: expect.stringContaining('TELEGRAM DELIVERY FAILED') });
    expect(w.pings.at(-1)?.body).toContain('Round 1 is UNSETTLED');
    w.telegramOk = true;
    at(C, UNSETTLED_ALERT_S + 300);
    await run();
    expect(w.messages).toHaveLength(2); // retried, then confirmed
    await run();
    expect(w.messages).toHaveLength(2);
  });

  it('an RPC outage sends no ping (Healthchecks catches a lasting one by its absence)', async () => {
    w.rounds = [active(C - 900)];
    w.rpcDown = true;
    at(C, UNSETTLED_ALERT_S);
    expect((await run()).status).toBe('rpc-error');
    expect(w.pings).toEqual([]);
  });

  it('moves its history cursor past every id it read, and keeps only open rounds to re-read', async () => {
    w.rounds = [
      { start: C - 900, status: STATUS.Settled, up: 1n, down: 1n },
      active(C - 900),
      { start: C - 900, status: STATUS.Settled, up: 1n, down: 1n },
    ];
    at(C, 60);
    await run();
    expect(w.meta.historyCursor).toBe(4);
    expect(w.meta.open).toEqual([2]);
  });

  it('never lets the Data Streams secret or the endpoints into a message or a ping', async () => {
    w.rounds = [active(C - 900), { start: C - 900, status: STATUS.Refunded, reason: REFUND_REASON.NoPrice, up: 1n, down: 1n }];
    w.telegramOk = false;
    at(C, 86_400 + 60);
    await run();
    const all = JSON.stringify([w.messages, w.pings, w.meta]);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('APIKEY');
    expect(all).not.toContain(RPC);
    expect(all).not.toContain(DS);
  });
});

// Codex T2.0d r1 regressions.
describe('an old open round never hides later ones', () => {
  it('reports a later unsettled round and a later NoPrice refund behind a round left open and 41 finished ones', async () => {
    const settled = (): R => ({ start: C - 900, status: STATUS.Settled, up: 1n, down: 1n });
    const late = C + 10 * 86_400;
    w.rounds = [active(C - 900)]; // round 1: two-sided, never settled, never refunded
    for (let i = 0; i < 41; i++) w.rounds.push(settled());
    w.rounds.push(active(late - 900)); // round 43
    w.rounds.push({ start: late - 900, status: STATUS.Refunded, reason: REFUND_REASON.NoPrice, up: 1n, down: 1n }); // 44
    at(late, UNSETTLED_ALERT_S);
    for (let i = 0; i < 4; i++) {
      await run();
      w.now += 300_000;
    }
    const all = w.messages.join('\n');
    expect(all).toContain('Round 1 is UNSETTLED');
    expect(all).toContain('Round 43 is UNSETTLED');
    expect(all).toContain('Round 44 REFUNDED NoPrice');
  });
});

describe('report checks rotate while Telegram is down', () => {
  it('gives every due round its report states within a bounded number of runs', async () => {
    w.rounds = Array.from({ length: 9 }, () => active(C - 900));
    w.telegramOk = false;
    at(C, UNSETTLED_ALERT_S);
    for (let i = 0; i < 3; i++) {
      await run();
      w.now += 300_000;
    }
    const body = w.pings.at(-1)?.body ?? '';
    for (let id = 1; id <= 9; id++) expect(body).toMatch(new RegExp(`Round ${id} is UNSETTLED[^\\n]*start \\S+ exists, close \\S+ exists`));
    expect(w.pings.at(-1)?.kind).toBe('fail');
  });
});

describe('a NoPrice alert states only what the API returned', () => {
  it('makes no causal claim whether the reports exist now or could not be checked', async () => {
    w.rounds = [
      { start: C - 900, status: STATUS.Refunded, reason: REFUND_REASON.NoPrice, up: 1n, down: 1n },
      { start: C - 1800, status: STATUS.Refunded, reason: REFUND_REASON.NoPrice, up: 1n, down: 1n },
    ];
    w.missing.add(C - 900); // round 2's close second: missing
    at(C, 86_400 + 60);
    await run();
    const text = w.messages.join('\n');
    expect(text).toContain('Round 1 REFUNDED NoPrice. At ');
    expect(text).toContain('Round 2 REFUNDED NoPrice. At ');
    expect(text).not.toMatch(/because|nobody delivered|no one could have|DELIVERY failure/);
  });
});

describe('report checks are not repeated needlessly', () => {
  it('reuses a check for 30 minutes while Telegram is down, then checks again', async () => {
    w.rounds = [active(C - 900)];
    w.telegramOk = false;
    at(C, UNSETTLED_ALERT_S);
    await run();
    expect(w.dsRequests).toBe(2);
    w.now += 25 * 60_000;
    await run();
    expect(w.dsRequests).toBe(2);
    w.now += 5 * 60_000;
    await run();
    expect(w.dsRequests).toBe(4);
  });
});

