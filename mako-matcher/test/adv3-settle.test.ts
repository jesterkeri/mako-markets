// Third adversary round on the settler: crash injection. The settler is stopped dead at EACH network await in a
// run (before the call leaves, and after the node has acted but before the settler heard), then a new Settler
// object is built on the same storage and run until quiet. Plan 6.1/6.2/6.3: one in flight, never a double send,
// the counters keep the reservation once, every proposal accepted is reported back.
import { describe, expect, it } from 'vitest';
import { rpc } from '../src/chain';
import type { Outcome } from '../src/outcome';
import { EXCHANGE, makeFetch } from './fake';
import { drive, prop, rows, withSettler } from './settle-helpers';
import { resetSettlerStorage, rig, SettleWorld, type Rig } from './settle-world';

/// Wraps the rig's node and outcome delivery so that the `target`-th event hangs for good (a process that died).
function crashing(r: Rig, target: number | null) {
  const st = { n: 0, crashed: false, total: 0, wake: () => undefined as void };
  const stopped = new Promise<void>((res) => (st.wake = res));
  const hang = async () => {
    st.crashed = true;
    st.wake();
    await new Promise<never>(() => undefined);
  };
  const tick = async () => {
    st.n++;
    st.total = st.n;
    if (st.n === target) await hang();
  };
  const inner = makeFetch(r.w);
  const fetchX = (async (i: RequestInfo | URL, x?: RequestInit) => {
    await tick();
    const res = await inner(i, x);
    await tick();
    return res;
  }) as typeof fetch;
  const net = { fetch: fetchX, now: () => r.w.nowMs, deadlineAt: Number.MAX_SAFE_INTEGER };
  const chain = { net, rpcUrl: 'https://rpc.test/', exchange: EXCHANGE, chainId: 10143 };
  r.over.chain = chain;
  r.over.broadcast = async (raw) => {
    const res = await rpc(net, chain.rpcUrl, 'eth_sendRawTransaction', [raw]);
    if (!res.ok) throw new Error(res.kind);
  };
  r.over.report = async (marketId, body) => {
    await tick();
    r.outcomes.push({ marketId, body: body as Outcome });
    await tick();
  };
  return { st, stopped };
}

async function scenario(target: number | null, setup: (w: SettleWorld) => void, p: () => ReturnType<typeof prop>) {
  const r = rig(new SettleWorld());
  setup(r.w);
  let total = 0;
  const result = await withSettler(async (sql, rg, mk) => {
    const c = crashing(rg, target);
    const s1 = mk(sql);
    await s1.submit(p());
    await Promise.race([s1.run().catch(() => undefined), c.stopped]);
    total = c.st.total;
    // The process is replaced: a new object on the same storage, a healthy node and a healthy market.
    delete rg.over.chain;
    delete rg.over.broadcast;
    delete rg.over.report;
    const s2 = mk(sql);
    for (let i = 0; i < 8; i++) await s2.run();
    return {
      sent: rg.w.sent.length,
      outcomes: rg.outcomes.map((o) => o.body),
      pending: rows(sql, 'SELECT * FROM pending').length,
      inFlight: rows(sql, 'SELECT * FROM in_flight').length,
      outbox: rows(sql, 'SELECT * FROM outbox').length,
      counters: rows<{ sends: number; mon_reserved: string }>(sql, 'SELECT sends, mon_reserved FROM counters'),
      failures: rows<{ n: number }>(sql, 'SELECT n FROM failures'),
      log: rows<{ status: string; charge: string | null; gas_limit: string; reserved: string }>(sql, 'SELECT status, charge, gas_limit, reserved FROM send_log'),
      w: rg.w,
    };
  }, r);
  return { ...result, total };
}

const happy = (w: SettleWorld) => void w;

describe('adversary 3: the settler dies at each await of a clean settlement (plan 6.2: one send, reported back; 6.3: counters keep the reservation once)', () => {
  it('after any single crash: exactly one transaction, one distinct outcome with the fills applied, nothing left over, the reservation counted once', async () => {
    const base = await scenario(null, happy, () => prop('directTakerBuy', ['directMakerSell']));
    expect(base.sent).toBe(1);
    const failures: string[] = [];
    for (let k = 1; k <= base.total; k++) {
      const x = await scenario(k, happy, () => prop('directTakerBuy', ['directMakerSell']));
      const ids = new Set(x.outcomes.map((o) => o.id));
      const applied = x.outcomes.filter((o) => (o.applied ?? []).length > 0);
      const c = x.counters[0];
      const problems: string[] = [];
      if (x.sent !== 1) problems.push(`sent ${x.sent} transactions`);
      if (ids.size !== 1) problems.push(`${ids.size} distinct outcomes`);
      if (applied.length === 0) problems.push('no outcome applied the fills');
      if (x.pending || x.inFlight || x.outbox) problems.push(`left over: pending ${x.pending}, in flight ${x.inFlight}, outbox ${x.outbox}`);
      if (!c || c.sends !== 1) problems.push(`counter sends ${c?.sends}`);
      const l = x.log[0];
      if (l && c && l.charge !== null && BigInt(c.mon_reserved) !== BigInt(l.charge)) problems.push(`reserved ${c.mon_reserved} != charge ${l.charge}`);
      if (problems.length) failures.push(`crash at event ${k}/${base.total}: ${problems.join('; ')}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('adversary 3: the settler dies at each await of a settlement that reverts in the mined transaction (rules: dropped, counted once, reported once)', () => {
  const reverting = (w: SettleWorld) => {
    w.onSend = () => ({ revert: { name: 'InsufficientCash', args: [prop('directTakerBuy', ['directMakerSell']).makers[0].hash] } });
  };
  it('after any single crash: the failure is counted once and the order is dropped once', async () => {
    const mkp = () => prop('directTakerBuy', ['directMakerSell']);
    const base = await scenario(null, reverting, mkp);
    const failures: string[] = [];
    for (let k = 1; k <= base.total; k++) {
      const x = await scenario(k, reverting, mkp);
      // a redelivery of one id is applied once by the market (test/inflight.test.ts), so count each id once
      const dropped = [...new Map(x.outcomes.map((o) => [o.id, o])).values()].flatMap((o) => o.dropped ?? []);
      const ids = new Set(x.outcomes.map((o) => o.id));
      const problems: string[] = [];
      if (x.sent !== 1) problems.push(`sent ${x.sent}`);
      if (ids.size !== 1) problems.push(`${ids.size} distinct outcomes`);
      if (dropped.length === 0) problems.push('nothing dropped');
      if (dropped.length > 1) problems.push(`dropped ${dropped.length} times`);
      if (x.failures.length !== 1 || x.failures[0].n !== 1) problems.push(`failures ${JSON.stringify(x.failures)}`);
      if (x.pending || x.inFlight || x.outbox) problems.push('left over');
      if (problems.length) failures.push(`crash at event ${k}/${base.total}: ${problems.join('; ')}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('adversary 3: outcome ids after the settler lost its storage (the market applies each id once; plan 6.2 Report back: every accepted proposal is reported, so its marks are released)', () => {
  it('the first outcome after a storage loss does not reuse an id a market has already applied', async () => {
    await withSettler(async (sql, r, mk) => {
      const delivered: string[] = [];
      r.over.report = async (_m, body) => {
        delivered.push((body as { id: string }).id);
      };
      await drive(mk(sql), prop('directTakerBuy', ['directMakerSell']), 3);
      // the settler's Durable Object storage is lost (counters, send log and outbox sequence with it)
      resetSettlerStorage(sql);
      r.w.confirmedNonce.clear();
      await drive(mk(sql), prop('directTakerBuy', ['directMakerSell']), 3);
      const first = new Set(delivered.slice(0, 1));
      const later = delivered.slice(1);
      expect(later.length).toBeGreaterThan(0);
      for (const id of later) expect(first.has(id), `outcome id ${id} was already delivered before the loss`).toBe(false);
    });
  });
});
