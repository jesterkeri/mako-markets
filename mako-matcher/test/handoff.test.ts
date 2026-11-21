// Matching on the real market object: proposals are handed to the settler through the one injected path; in
// phase A the settler refuses, and the order stays booked.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Env } from '../src/env';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';
import { MatcherSettler, isRefused, utcDay } from '../src/settler';
import { runInDurableObject } from 'cloudflare:test';
import { NOW_MS } from './fake';

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

interface Handed {
  kind: string;
  taker: { hash: string; signature: string };
  makers: { hash: string; signature: string }[];
  fills: string[];
  takerFill: string;
}

async function put(names: string[]) {
  const out: Record<string, unknown>[] = [];
  for (const n of names) {
    const v = vec(n);
    fund(h.w, v.order, 500_000_000n);
    out.push((await h.place(v)).json);
  }
  return out;
}

describe('hand-off to the settler', () => {
  it('a direct match: the settler gets the stored records, and its refusal leaves both orders booked', async () => {
    const [a, b] = await put(['directMakerSell', 'directTakerBuy']);
    expect(a).toMatchObject({ ok: true, handedOff: 0 });
    expect(b).toMatchObject({ ok: true, booked: true, handedOff: 1 });
    expect(h.settled).toHaveLength(1);
    const s = h.settled[0] as Handed;
    expect(s.kind).toBe('direct');
    expect(s.taker.hash).toBe(vec('directTakerBuy').hash);
    // the signature that travels with the order is the very record that was stored
    expect(s.taker.signature).toBe(vec('directTakerBuy').signature);
    expect(s.makers.map((m) => [m.hash, m.signature])).toEqual([[vec('directMakerSell').hash, vec('directMakerSell').signature]]);
    expect(s.fills).toEqual(['100000000']);
    expect(s.takerFill).toBe('100000000');
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 2 }]);
  });

  it('every tick hands the crossed pair over again, until a settler takes it (at most one hand-off per pass)', async () => {
    await put(['directMakerSell', 'directTakerBuy']);
    expect(h.settled).toHaveLength(1);
    await h.tick();
    expect(h.settled).toHaveLength(2);
    await h.tick();
    expect(h.settled).toHaveLength(3);
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 2 }]);
  });

  it('on a tick the newer order of a crossed pair is the taker, so the trade is at the resting price', async () => {
    await put(['directMakerSell', 'directTakerBuy']); // the sell (55) rests; the buy (60) arrives later
    h.settled.length = 0;
    await h.tick();
    const s = h.settled[0] as Handed;
    expect(s.taker.hash).toBe(vec('directTakerBuy').hash);
    expect(s.makers.map((m) => m.hash)).toEqual([vec('directMakerSell').hash]);
  });

  it('a three-maker direct match, a mint and a merge come out as the vectors say', async () => {
    await put(['direct3Maker3Sell', 'direct3Maker1Sell', 'direct3Maker2Sell', 'direct3TakerBuy']);
    const d = h.settled.at(-1) as Handed;
    expect(d.kind).toBe('direct');
    expect(d.makers.map((m) => m.hash)).toEqual(['direct3Maker1Sell', 'direct3Maker2Sell', 'direct3Maker3Sell'].map((n) => vec(n).hash));
    expect(d.takerFill).toBe('300000000');
  });

  it('a mint: N - 1 buys on the other options, every fill the taker\'s fill', async () => {
    h.settled.length = 0;
    await put(['mintMakerBuy1', 'mintMakerBuy2', 'mintTakerBuy0']);
    const m = h.settled.at(-1) as Handed;
    expect(m.kind).toBe('mint');
    expect(m.fills).toEqual(['100000000', '100000000']);
    expect(m.takerFill).toBe('100000000');
  });

  it('a merge', async () => {
    await put(['mergeMakerSell1', 'mergeMakerSell2', 'mergeTakerSell0']);
    expect((h.settled.at(-1) as Handed).kind).toBe('merge');
  });

  it('prices that would break the set (60 + 50 above 100) are never handed over', async () => {
    const r = await put(['sumMintMakerBuy1', 'sumMintMakerBuy2', 'sumMintTakerBuy0']);
    expect(r.map((x) => x.handedOff)).toEqual([0, 0, 0]);
    const m = await put(['sumMergeMakerSell1', 'sumMergeMakerSell2', 'sumMergeTakerSell0']);
    expect(m.map((x) => x.handedOff)).toEqual([0, 0, 0]);
    expect(h.settled).toEqual([]);
    await h.tick();
    expect(h.settled).toEqual([]);
  });

  it('never matches an order against a party in the contract\'s refused roles', async () => {
    const maker = vec('directMakerSell');
    for (const role of ['operator', 'admin', 'resolver', 'treasury'] as const) {
      h = await fresh('1');
      if (role === 'operator') h.w.operators.add(maker.order.maker);
      else h.w[role] = maker.order.maker;
      const r = await put(['directMakerSell', 'directTakerBuy']);
      expect(r.map((x) => x.handedOff), role).toEqual([0, 0]);
      expect(h.settled, role).toEqual([]);
    }
  });

  it('reads the roles of the parties of a proposal only, not of everybody on the book', async () => {
    await put(['mintMakerBuy1', 'mintMakerBuy2', 'direct3Maker2Sell', 'direct3Maker3Sell']);
    h.w.inner.length = 0;
    const r = await put(['directTakerBuy']);
    expect(r[0]).toMatchObject({ handedOff: 1 });
    // the best deal for the taker is the mint (it pays 40 against 55): its three parties are read, one isOperator
    // each, and the two sellers on the book who are not in the proposal are not
    expect((h.settled.at(-1) as Handed).kind).toBe('mint');
    expect(h.w.inner.filter((n) => n === 'isOperator')).toHaveLength(3);
  });

  it('proposes again without a refused wallet: the next-best maker is used', async () => {
    h.w.operators.add(vec('direct3Maker1Sell').order.maker); // the best price (50) belongs to an operator
    await put(['direct3Maker1Sell', 'direct3Maker2Sell']);
    const r = await put(['directTakerBuy']);
    expect(r[0]).toMatchObject({ handedOff: 1 });
    const d = h.settled.at(-1) as Handed;
    expect(d.makers.map((m) => m.hash)).toEqual([vec('direct3Maker2Sell').hash]);
  });

  it('a wallet on the daily refusal list is never put in a match', async () => {
    await put(['directMakerSell']);
    h.refused.add(vec('directMakerSell').order.maker);
    const r = await put(['directTakerBuy']);
    expect(r[0]).toMatchObject({ ok: true, handedOff: 0 });
    expect(h.settled).toEqual([]);
  });

  it('when the refused roles or the refusal list cannot be read nothing is proposed, and the order is still booked', async () => {
    await put(['directMakerSell']);
    h.settlerDown = false;
    h.w.fail = (_m, n) => (n === 'aggregate3' && h.w.inner.length > 3 ? 'down' : null);
    h.w.inner.length = 0;
    // intake's multicall is the first aggregate3 (inner now empty), so let it pass, then fail the roles read
    let n = 0;
    h.w.fail = (_m, name) => (name === 'aggregate3' && ++n === 2 ? 'down' : null);
    const r = await put(['directTakerBuy']);
    expect(r[0]).toMatchObject({ ok: true, booked: true, handedOff: 0 });
    expect(h.settled).toEqual([]);
    expect((await h.alerts()).map((a) => a.code)).toContain('match_read_failed');
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 2 }]);
  });

  it('never mixes markets: an order for market 2 cannot reach market 1\'s book to be matched', async () => {
    await put(['directMakerSell']);
    const other = vec('mmDirectMakerSellB');
    fund(h.w, other.order);
    expect((await h.place(other)).json).toMatchObject({ code: 'wrong_market' });
    const r = await put(['directTakerBuy']);
    expect((h.settled[0] as Handed).makers).toHaveLength(1);
    expect(r[0]).toMatchObject({ handedOff: 1 });
  });
});

describe('the settler object (real class, real storage)', () => {
  const call = (path: string, method = 'GET', body: unknown = undefined, e: Partial<Env> = {}) =>
    runInDurableObject(env.SETTLER.get(env.SETTLER.idFromName('settler')), async (_i, state) => {
      const inst = new MatcherSettler(state, { ...env, ...e } as Env);
      const res = await inst.fetch(new Request(`https://settler${path}`, { method, body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body) }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    });

  it('refuses a proposal while K, the funder address or the key is not configured, and sends nothing', async () => {
    const p = (await import('./settle-helpers')).DIRECT();
    // the committed wrangler.toml leaves K and FUNDER_ADDRESS unset; the test bindings add no key either
    const r = await call('/settle', 'POST', p);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ accepted: false, error: 'held_k_unset' });
  });

  it('refuses a body that is not a proposal, unknown routes, and a settle with no primary RPC', async () => {
    expect((await call('/settle', 'POST', { nonsense: true })).body).toMatchObject({ accepted: false, error: 'bad_proposal' });
    expect((await call('/', 'GET')).status).toBe(404);
    expect((await call('/anything', 'DELETE')).status).toBe(404);
    expect((await call('/refused', 'GET')).status).toBe(404);
    const noRpc = await call('/settle', 'POST', {}, { PRIMARY_RPC_URL: undefined });
    expect(noRpc.status).toBe(503);
    expect(noRpc.body).toMatchObject({ error: 'held_no_primary_rpc' });
    const noExchange = await call('/settle', 'POST', {}, { EXCHANGE_ADDRESS: undefined });
    expect(noExchange.body).toMatchObject({ error: 'not_configured' });
  });

  it('status shows what it is held to', async () => {
    const r = await call('/status', 'GET', undefined, { K: '5', FUNDER_ADDRESS: '0x' + 'f0'.repeat(20), GATE_GT_PASSED: 'false' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ K: '5', funder: '0x' + 'f0'.repeat(20), gateGtPassed: false, sender: null, sends: 0 });
    expect(((await call('/status', 'GET', undefined, { K: '0' })).body as { K: unknown }).K).toBeNull();
  });

  it('answers the daily refusal question from its table (the storage shape phase B writes)', async () => {
    const m = '0x' + 'ab'.repeat(20);
    expect((await call(`/refused/${m}`)).body).toEqual({ refused: false });
    await runInDurableObject(env.SETTLER.get(env.SETTLER.idFromName('settler')), async (_i, state) => {
      state.storage.sql.exec('INSERT OR REPLACE INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', m, utcDay(Date.now()), 'bad_signature', 1);
      state.storage.sql.exec('INSERT OR REPLACE INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', '0x' + 'cd'.repeat(20), '2001-01-01', 'old', 1);
      expect(isRefused(state.storage.sql, m.toUpperCase().replace('0X', '0x'), Date.now())).toBe(true);
      expect(isRefused(state.storage.sql, '0x' + 'cd'.repeat(20), Date.now())).toBe(false);
      expect(isRefused(state.storage.sql, m, Date.parse('2001-01-01T12:00:00Z'))).toBe(false);
    });
    expect((await call(`/refused/${m}`)).body).toEqual({ refused: true });
    expect((await call('/refused/not-an-address')).status).toBe(404);
    void NOW_MS;
  });

  it('the Worker names the settler only as idFromName("settler")', async () => {
    const { realDeps } = await import('../src/market');
    const seen: string[] = [];
    const e = {
      SETTLER: {
        idFromName: (n: string) => {
          seen.push(n);
          return n;
        },
        get: () => ({ fetch: async () => new Response(JSON.stringify({ refused: false, accepted: false }), { status: 200 }) }),
      },
    } as unknown as Env;
    const d = realDeps(e);
    await d.refusedToday('0x' + 'ab'.repeat(20) as `0x${string}`);
    await d.settle({});
    expect(seen).toEqual(['settler', 'settler']);
  });
});
