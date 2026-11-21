import { beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { MAX_OPEN_ORDERS } from '../src/config';
import type { OrderTuple } from '../src/abi';
import { orderHash } from '../src/order';
import { fresh, fund, type Harness } from './harness';
import { EXCHANGE, NOW_MS, SAFE_PROXY_CODE } from './fake';
import { V, vec, signWithKey, body, toTuple, type VecOrder } from './vectors';

const NOW_S = Math.floor(NOW_MS / 1000);
const DAY = 86_400;
let salt = 1000n;

/// A fresh signed order from one of the vectors' test keys (market 1, option 0, buy 60 for 100 shares).
async function mk(key: string, over: Partial<OrderTuple> = {}, domainExchange: Hex = EXCHANGE): Promise<VecOrder> {
  const order: OrderTuple = {
    salt: salt++,
    maker: V.keys[key].address.toLowerCase() as Hex,
    marketId: 1n,
    option: 0,
    isBuy: true,
    price: 60,
    size: 100_000_000n,
    expiration: BigInt(NOW_S + DAY),
    nonce: 0n,
    ...over,
  };
  const signature = await signWithKey(key, order, domainExchange);
  return { name: 'custom', order, signature, hash: orderHash(order, { chainId: 10143, exchange: domainExchange }) };
}

const callList = (h: Harness) => h.w.calls.filter((c) => c.method !== 'eth_chainId').map((c) => c.method + (c.name ? `:${c.name}` : ''));
const noBatch = (h: Harness) => expect(h.w.calls.some((c) => c.batch), 'a JSON-RPC array body was sent').toBe(false);
async function rows(h: Harness) {
  return h.sql<{ hash: string; signature: string }>('SELECT hash, signature FROM orders');
}

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
  h.w.addSafe(V.safes.safeTaker.address, V.safes.safeTaker.ownerAddress);
  h.w.addSafe(V.safes.safeMaker1.address, V.safes.safeMaker1.ownerAddress);
});

describe('a valid order is booked', () => {
  it('stores order and signature as ONE record, reads with one multicall, and arms the alarm', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    const r = await h.place(o);
    expect(r).toEqual({ status: 200, json: { ok: true, hash: o.hash, booked: true, handedOff: 0 } });
    expect(await rows(h)).toEqual([{ hash: o.hash, signature: o.signature }]);
    // block number (log cursor), then ONE multicall; nothing else, and never a JSON-RPC array
    // (eth_chainId is asked once per object lifetime, so it is left out of exact lists)
    expect(callList(h)).toEqual(['eth_blockNumber', 'eth_call:aggregate3', 'eth_call:aggregate3']);
    expect(h.w.inner.slice(0, 5)).toEqual(['marketOf', 'nonces', 'orders', 'cash', 'feeOf']);
    noBatch(h);
    expect(await h.sql('SELECT v FROM meta WHERE k = ?', 'log_cursor')).toEqual([{ v: '5000' }]);
    expect(await h.sql('SELECT v FROM meta WHERE k = ?', 'n_options')).toEqual([{ v: '3' }]);
    expect(await h.sql('SELECT v FROM meta WHERE k = ?', 'market_id')).toEqual([{ v: '1' }]);
    // the second aggregate3 is the matcher's read of the refused roles before it looks for a counterparty
  });

  it('a record cannot exist without its signature', async () => {
    await expect(
      h.sql(
        `INSERT INTO orders (hash, maker, salt, market_id, option, is_buy, price, size, expiration, nonce, signature, fee, filled, created_at)
         VALUES ('0x01', '0x02', '1', '1', 0, 1, 50, '10', 1, '0', '', '0', '0', 1)`,
      ),
    ).rejects.toThrow();
  });

  it('refuses the same order twice', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    expect((await h.place(o)).status).toBe(200);
    expect((await h.place(o)).json).toMatchObject({ ok: false, code: 'duplicate_order' });
    expect(await rows(h)).toHaveLength(1);
  });
});

describe('bad signatures, nonces, funds', () => {
  it('refuses a signature made for another order as bad_signature and stores nothing', async () => {
    const a = vec('directTakerBuy');
    const b = vec('mintTakerBuy0');
    fund(h.w, a.order);
    const r = await h.place({ ...a, signature: b.signature });
    expect(r.json).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(await rows(h)).toEqual([]);
    expect(h.w.ethCallCount()).toBe(0);
  });

  it('refuses an empty signature before any RPC call', async () => {
    const o = await mk('eoaTaker');
    const r = await h.place({ ...o, signature: '0x' });
    expect(r.json).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(h.w.calls).toEqual([]);
  });

  it('196 bytes is C5 before any RPC call; 195 bytes passes the length gate and fails on its merits', async () => {
    const o = await mk('eoaTaker');
    const long = `0x${'ab'.repeat(196)}` as Hex;
    const r196 = await h.place({ ...o, signature: long });
    expect(r196.json).toEqual({ ok: false, code: 'signature_too_long', copy: 'C5' });
    expect(h.w.calls).toEqual([]);
    const r195 = await h.place({ ...o, signature: `0x${'ab'.repeat(195)}` as Hex });
    // an EOA maker with a non-recovering signature: a bad signature, not "too long"
    expect(r195.json).toMatchObject({ ok: false, code: 'bad_signature' });
    // a Safe maker with a 195-byte signature is an unsupported form (C7), also not "too long"
    const s = vec('safeTakerBuy');
    const r195s = await h.place({ ...s, signature: `0x${'ab'.repeat(195)}` as Hex });
    expect(r195s.json).toEqual({ ok: false, code: 'unsupported_wallet', copy: 'C7' });
  });

  it('refuses a wrong nonce', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    h.w.nonces.set(o.order.maker, 1n);
    expect((await h.place(o)).json).toMatchObject({ ok: false, code: 'nonce_mismatch' });
    expect(await rows(h)).toEqual([]);
  });

  it('accepts the nonce the chain holds', async () => {
    const o = await mk('eoaTaker', { nonce: 4n });
    fund(h.w, o.order);
    h.w.nonces.set(o.order.maker, 4n);
    expect((await h.place(o)).status).toBe(200);
  });

  it('refuses an unfunded buy and an unfunded sell', async () => {
    const buy = await mk('eoaTaker');
    expect((await h.place(buy)).json).toMatchObject({ ok: false, code: 'insufficient_cash' });
    const sell = await mk('eoaMaker1', { isBuy: false });
    expect((await h.place(sell)).json).toMatchObject({ ok: false, code: 'insufficient_shares' });
    expect(await rows(h)).toEqual([]);
  });

  it('cash must cover cost plus fee', async () => {
    h.w.markets.set('1', { ...h.w.markets.get('1')!, feeRate: 700n });
    const o = await mk('eoaTaker');
    const fee = (700n * o.order.size * 60n * 40n + 10n ** 8n - 1n) / 10n ** 8n;
    expect(fee).toBeGreaterThan(0n);
    h.w.setCash(o.order.maker, 60_000_000n + fee - 1n);
    expect((await h.place(o)).json).toMatchObject({ code: 'insufficient_cash' });
    h.w.setCash(o.order.maker, 60_000_000n + fee);
    expect((await h.place(o)).status).toBe(200);
  });

  it('refuses an order cancelled on chain and one already filled on chain', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    h.w.orders.set(a.hash, { filled: 0n, cancelled: true });
    expect((await h.place(a)).json).toMatchObject({ code: 'order_cancelled' });
    const b = await mk('eoaTaker');
    fund(h.w, b.order);
    h.w.orders.set(b.hash, { filled: b.order.size, cancelled: false });
    expect((await h.place(b)).json).toMatchObject({ code: 'order_filled' });
    expect(await rows(h)).toEqual([]);
  });

  it('only what is left after an on-chain fill must reach 10 shares', async () => {
    const o = await mk('eoaTaker', { size: 15_000_000n });
    fund(h.w, o.order);
    h.w.orders.set(o.hash, { filled: 6_000_000n, cancelled: false });
    expect((await h.place(o)).json).toMatchObject({ code: 'size_below_minimum' });
  });
});

describe('field limits', () => {
  it('expiration 0 and more than 7 days ahead are refused; exactly 7 days and one second less pass', async () => {
    for (const expiration of [0n, BigInt(NOW_S + 7 * DAY + 1)]) {
      const o = await mk('eoaTaker', { expiration });
      fund(h.w, o.order);
      expect((await h.place(o)).json, String(expiration)).toMatchObject({ ok: false, code: 'bad_expiration' });
    }
    expect(h.w.calls).toEqual([]);
    const edge = await mk('eoaTaker', { expiration: BigInt(NOW_S + 7 * DAY) });
    fund(h.w, edge.order);
    expect((await h.place(edge)).status).toBe(200);
  });

  it('an order that has already expired is refused; one that expires next second is not', async () => {
    const past = await mk('eoaTaker', { expiration: BigInt(NOW_S) });
    expect((await h.place(past)).json).toMatchObject({ code: 'expired' });
    const next = await mk('eoaTaker', { expiration: BigInt(NOW_S + 1) });
    fund(h.w, next.order);
    expect((await h.place(next)).status).toBe(200);
  });

  it('price 0 and 100 (signed vectors), size 0 and a size off the lot are refused before any RPC call', async () => {
    for (const name of ['price0TakerBuy', 'price100MakerBuy2']) {
      expect((await h.place(vec(name))).json, name).toMatchObject({ code: 'bad_price' });
    }
    for (const size of [0n, 10_000_001n, 15_000_000n + 1n]) {
      const o = await mk('eoaTaker', { size });
      expect((await h.place(o)).json, String(size)).toMatchObject({ code: 'bad_size' });
    }
    expect(h.w.calls).toEqual([]);
  });

  it('10 shares rest; 9.99 shares do not', async () => {
    const small = await mk('eoaTaker', { size: 9_990_000n });
    fund(h.w, small.order);
    expect((await h.place(small)).json).toMatchObject({ code: 'size_below_minimum' });
    const edge = await mk('eoaTaker', { size: 10_000_000n });
    fund(h.w, edge.order);
    expect((await h.place(edge)).status).toBe(200);
  });

  it('the option must be below the market option count, read from the contract', async () => {
    const o = await mk('eoaTaker', { option: 3 });
    fund(h.w, o.order);
    expect((await h.place(o)).json).toMatchObject({ code: 'bad_option' });
    const ok = await mk('eoaTaker', { option: 2 });
    fund(h.w, ok.order);
    expect((await h.place(ok)).status).toBe(200);
  });

  it('refuses a market that is closed, one that does not exist, and one not open', async () => {
    h.w.markets.set('1', { ...h.w.markets.get('1')!, tradingClose: BigInt(NOW_S) });
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    expect((await h.place(o)).json).toMatchObject({ code: 'market_closed' });
    h.w.markets.set('1', { ...h.w.markets.get('1')!, tradingClose: 4_000_000_000n, status: 2 });
    expect((await h.place(o)).json).toMatchObject({ code: 'market_not_open' });
    h.w.markets.delete('1');
    expect((await h.place(o)).json).toMatchObject({ code: 'market_not_open' });
  });

  it('rejects malformed and oversized bodies', async () => {
    const res = await h.call('POST', '/orders', { body: { order: {}, signature: '0x' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: 'bad_request' });
    const big = await h.call('POST', '/orders', { body: { pad: 'x'.repeat(10_000) } });
    expect((await big.json()) as unknown).toEqual({ ok: false, code: 'bad_request' });
  });
});

describe('wrong_market (plan 6.1, 6.2 step 1)', () => {
  it('an order for market 2 sent to market 1 is refused, and nothing is stored or reserved', async () => {
    const wrong = vec('mmDirectMakerSellB');
    expect(wrong.order.marketId).toBe(2n);
    fund(h.w, wrong.order);
    const r = await h.place(wrong);
    expect(r).toEqual({ status: 400, json: { ok: false, code: 'wrong_market' } });
    expect(await rows(h)).toEqual([]);
    expect(h.w.calls).toEqual([]);
    // the same order sent to market 2's own object is accepted
    const h2 = await fresh('2');
    h2.w.markets.set('2', { nOptions: 3, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
    fund(h2.w, wrong.order);
    expect((await h2.place(wrong)).status).toBe(200);
  });
});

describe('supported wallets (plan 4.6): C7 before any eth_call', () => {
  const word = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}` as Hex;

  async function safeOrder(): Promise<VecOrder> {
    const s = vec('safeTakerBuy');
    fund(h.w, s.order);
    return s;
  }

  it('accepts the email Safe: code, two slots, then the exchange check with a 1,000,000 gas allowance', async () => {
    const s = await safeOrder();
    expect((await h.place(s)).status).toBe(200);
    expect(callList(h).slice(0, 5)).toEqual([
      'eth_getCode',
      'eth_getStorageAt',
      'eth_getStorageAt',
      'eth_call:isValidOrderSignature',
      'eth_blockNumber',
    ]);
    expect(h.w.calls.find((c) => c.name === 'isValidOrderSignature')!.gas).toBe('0xf4240');
    noBatch(h);
  });

  it('an email Safe whose owner did not sign is refused with C5, because the address has code', async () => {
    const s = await safeOrder();
    h.w.safeOwner.set(s.order.maker, V.safes.safeMaker1.ownerAddress.toLowerCase() as Hex);
    expect((await h.place(s)).json).toEqual({ ok: false, code: 'signature_check_failed', copy: 'C5' });
    expect(await rows(h)).toEqual([]);
  });

  const cases: [string, (s: VecOrder) => Promise<VecOrder>][] = [
    [
      'a Safe with another fallback handler',
      async (s) => {
        h.w.storage.set(`${s.order.maker}:0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5`, word('0x' + '33'.repeat(20)));
        return s;
      },
    ],
    [
      'a Safe with another singleton',
      async (s) => {
        h.w.storage.set(`${s.order.maker}:0x${'0'.repeat(64)}`, word('0x' + '44'.repeat(20)));
        return s;
      },
    ],
    [
      'a non-Safe contract',
      async (s) => {
        h.w.code.set(s.order.maker, '0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe');
        return s;
      },
    ],
    [
      'a Safe whose owner signs the plain typed-data form (v 27/28, not the Safe form)',
      async (s) => ({ ...s, signature: await signWithKey('safeOwnerTaker', s.order) }),
    ],
    [
      'a Safe with a contract owner (signature form v = 0, the GasGatedOwner shape)',
      async (s) => ({ ...s, signature: `0x${'00'.repeat(12)}${'ab'.repeat(20)}${'00'.repeat(31)}41${'00'}` as Hex }),
    ],
    [
      'a Safe with another proxy code hash',
      async (s) => {
        h.w.code.set(s.order.maker, SAFE_PROXY_CODE.replace(/.$/, '1') as Hex);
        return s;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    it(`refuses ${name} with C7 and makes no eth_call`, async () => {
      const s = await mutate(await safeOrder());
      const r = await h.place(s);
      expect(r.json).toEqual({ ok: false, code: 'unsupported_wallet', copy: 'C7' });
      expect(h.w.ethCallCount()).toBe(0);
      expect(await rows(h)).toEqual([]);
    });
  }

  it('an EOA with an EIP-7702 delegation that signs plainly is accepted, and its code is never read', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    h.w.code.set(o.order.maker, `0xef0100${'ab'.repeat(20)}`);
    expect((await h.place(o)).status).toBe(200);
    expect(h.w.calls.some((c) => c.method === 'eth_getCode')).toBe(false);
  });

  it('a 7702 account whose signature does not recover is a bad signature, not C7, and nothing runs', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    h.w.code.set(o.order.maker, `0xef0100${'ab'.repeat(20)}`);
    const other = await signWithKey('eoaMaker1', o.order);
    expect((await h.place({ ...o, signature: other })).json).toEqual({ ok: false, code: 'bad_signature' });
    expect(h.w.ethCallCount()).toBe(0);
  });

  it('a 7702 account with a high-s twin or v 0/1 is a bad signature (the contract would run the delegate)', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    h.w.code.set(o.order.maker, `0xef0100${'ab'.repeat(20)}`);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${o.signature.slice(66, 130)}`);
    const v = parseInt(o.signature.slice(130, 132), 16);
    const high = `0x${o.signature.slice(2, 66)}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    const v01 = `${o.signature.slice(0, 130)}${(v - 27).toString(16).padStart(2, '0')}` as Hex;
    for (const sig of [high, v01]) {
      expect((await h.place({ ...o, signature: sig })).json).toEqual({ ok: false, code: 'bad_signature' });
    }
    expect(h.w.ethCallCount()).toBe(0);
  });

  it('a wallet with no code and a non-recovering signature is a bad signature', async () => {
    const o = await mk('eoaTaker');
    const other = await signWithKey('eoaMaker1', o.order);
    expect((await h.place({ ...o, signature: other })).json).toEqual({ ok: false, code: 'bad_signature' });
  });
});

describe('the 20-order cap and reservations (plan 5, 6.2 step 3)', () => {
  it('a wallet may hold 20 open orders in a market; the 21st is refused; another wallet is not affected', async () => {
    h.w.setCash(V.keys.eoaTaker.address, 10n ** 15n);
    h.w.setCash(V.keys.eoaMaker1.address, 10n ** 15n);
    for (let i = 0; i < MAX_OPEN_ORDERS; i++) {
      const o = await mk('eoaTaker', { price: 10 + (i % 5), size: 10_000_000n });
      expect((await h.place(o)).status, `order ${i}`).toBe(200);
    }
    const extra = await mk('eoaTaker', { size: 10_000_000n });
    expect((await h.place(extra)).json).toMatchObject({ ok: false, code: 'too_many_orders' });
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 20 }]);
    const other = await mk('eoaMaker1', { size: 10_000_000n, price: 12 });
    expect((await h.place(other)).status).toBe(200);
  });

  it('a resting buy reserves cash against the next one in this market', async () => {
    const a = await mk('eoaTaker'); // costs 60 USDC
    const b = await mk('eoaTaker');
    h.w.setCash(a.order.maker, 100_000_000n);
    expect((await h.place(a)).status).toBe(200);
    expect((await h.place(b)).json).toMatchObject({ code: 'insufficient_cash' });
    // 40 USDC is left: a 40-USDC buy still fits
    const c = await mk('eoaTaker', { price: 40 });
    expect((await h.place(c)).status).toBe(200);
  });

  it('a resting sell reserves shares of that option only', async () => {
    const a = await mk('eoaMaker1', { isBuy: false });
    h.w.setPosition(1n, 0, a.order.maker, 100_000_000n);
    h.w.setPosition(1n, 1, a.order.maker, 50_000_000n);
    expect((await h.place(a)).status).toBe(200);
    const same = await mk('eoaMaker1', { isBuy: false, size: 10_000_000n });
    expect((await h.place(same)).json).toMatchObject({ code: 'insufficient_shares' });
    const other = await mk('eoaMaker1', { isBuy: false, option: 1, size: 50_000_000n });
    expect((await h.place(other)).status).toBe(200);
  });

  it('two orders in flight at once cannot both pass the reservation check', async () => {
    const a = await mk('eoaTaker');
    const b = await mk('eoaTaker');
    h.w.setCash(a.order.maker, 100_000_000n);
    const [ra, rb] = await Promise.all([h.place(a), h.place(b)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 400]);
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 1 }]);
  });

  it('expired orders neither count toward the cap nor reserve cash', async () => {
    const a = await mk('eoaTaker', { expiration: BigInt(NOW_S + 5) });
    h.w.setCash(a.order.maker, 60_000_000n);
    expect((await h.place(a)).status).toBe(200);
    h.w.nowMs += 10_000;
    const b = await mk('eoaTaker', { expiration: BigInt(NOW_S + DAY) });
    expect((await h.place(b)).status).toBe(200);
  });
});

describe('the daily refusal list (plan 6.2: N = 1 / N = 3)', () => {
  it('an account on the list is refused at intake and nothing is stored', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    h.refused.add(o.order.maker);
    expect((await h.place(o)).json).toEqual({ ok: false, code: 'account_refused_today' });
    expect(await rows(h)).toEqual([]);
  });
  it('an unreadable list fails closed', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    h.settlerDown = true;
    expect(await h.place(o)).toEqual({ status: 503, json: { ok: false, code: 'refusal_list_unavailable' } });
    expect(await rows(h)).toEqual([]);
  });
});

describe('the chain failing', () => {
  for (const kind of ['down', 'rate', 'garbage'] as const) {
    it(`a ${kind} node refuses the order with 503 and stores nothing`, async () => {
      const o = await mk('eoaTaker');
      fund(h.w, o.order);
      h.w.fail = (m, n) => (n === 'aggregate3' ? kind : null);
      const r = await h.place(o);
      expect(r).toEqual({ status: 503, json: { ok: false, code: 'chain_read_failed' } });
      expect(await rows(h)).toEqual([]);
      expect((await h.alerts()).map((a) => a.code)).toContain('chain_read_failed');
    });
  }

  it('a node on another chain is refused before anything it says is believed', async () => {
    const h77 = await fresh('77');
    h77.w.chainId = 31337;
    h77.w.markets.set('77', { nOptions: 3, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
    const o = await mk('eoaTaker', { marketId: 77n });
    h77.w.setCash(o.order.maker, 10n ** 12n);
    expect(await h77.place(o)).toEqual({ status: 503, json: { ok: false, code: 'chain_read_failed' } });
    expect((await h77.alerts()).map((a) => a.detail)).toContain('eth_chainId wrong_chain');
    expect(h77.w.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  it('with no exchange address configured nothing is read or booked', async () => {
    const o = await mk('eoaTaker');
    fund(h.w, o.order);
    const res = await h.call('POST', '/orders', { body: body(o.order, o.signature), env: { EXCHANGE_ADDRESS: undefined } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: 'not_configured' });
    expect(h.w.calls).toEqual([]);
    expect(await rows(h)).toEqual([]);
  });
});

describe('the vectors themselves', () => {
  it('every vector EOA order signed for market 1 is accepted when funded', async () => {
    for (const name of ['directTakerBuy', 'directMakerSell', 'mintMakerBuy1', 'mintMakerBuy2', 'direct3Maker2Sell']) {
      const v = vec(name);
      fund(h.w, v.order, 500_000_000n);
      expect((await h.place(v)).status, name).toBe(200);
    }
    void toTuple;
  });
});
