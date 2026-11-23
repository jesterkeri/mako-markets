import { describe, expect, it } from 'vitest';
import { encodeErrorResult, type Hex } from 'viem';
import { EXCHANGE_ABI } from '../src/abi';
import { decodeMatch, encodeMatch, parseProposal, type Rec, type WireProposal } from '../src/encode';
import { allowedFor, checkFrames, ECRECOVER, outsiders, parseTrace, topRevert } from '../src/trace';
import { SAFE_4337_MODULE, SAFE_SINGLETON } from '../src/wallets';
import { V } from './vectors';
import { NOW_MS } from './fake';

function rec(name: string, sig: Hex): Rec {
  const f = V.orders[name].fields as Record<string, never>;
  return { hash: `0x${'00'.repeat(32)}`, signature: sig, bookedAt: NOW_MS, order: { ...(f as object), maker: String(f.maker).toLowerCase() } as Rec['order'] };
}

type Call = { id: string; taker: string; makers: string[]; takerSig: Hex; makerSigs: Hex[]; fills: string[]; takerFill: string; calldata: Hex };
const calls = [...V.calls, ...((V as unknown as { negatives: Call[] }).negatives)] as unknown as Call[];

describe('the settlement call is built from records, byte for byte as the vectors say', () => {
  for (const c of calls) {
    // a record list cannot be shorter than its signature list: those two negatives are not buildable from records
    if (c.makerSigs.length !== c.makers.length || c.fills.length !== c.makers.length) continue;
    it(`${c.id}`, () => {
      const p: WireProposal = {
        kind: 'direct',
        marketId: '1',
        taker: rec(c.taker, c.takerSig),
        makers: c.makers.map((m, i) => rec(m, c.makerSigs[i])),
        fills: c.fills,
        takerFill: c.takerFill,
      };
      // the market-2 vectors name another market on purpose; they are encoded the same way, minus the guard
      const mixed = p.makers.some((m) => m.order.marketId !== p.taker.order.marketId);
      const out = encodeMatch(p);
      if (mixed) {
        expect(out.ok).toBe(false);
      } else {
        expect(out).toEqual({ ok: true, data: c.calldata });
        const back = decodeMatch(c.calldata)!;
        expect(back.makerSigs).toEqual(c.makerSigs);
        expect(back.takerSig).toBe(c.takerSig);
      }
    });
  }

  it('covers at least 40 vector calls', () => {
    expect(calls.filter((c) => c.makerSigs.length === c.makers.length && c.fills.length === c.makers.length).length).toBeGreaterThanOrEqual(40);
  });

  it('a 10-maker call keeps each signature at its maker\'s index', () => {
    const makers: Rec[] = Array.from({ length: 10 }, (_, i) => ({
      hash: `0x${i.toString(16).padStart(64, '0')}` as Hex,
      signature: `0x${(0xa0 + i).toString(16)}${i.toString(16).padStart(2, '0')}` as Hex,
      bookedAt: NOW_MS,
      order: { salt: String(100 + i), maker: `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex, marketId: '1', option: 0, isBuy: false, price: 50, size: '10000000', expiration: '2000000000', nonce: '0' },
    }));
    const taker = rec('directTakerBuy', '0xabcd');
    const out = encodeMatch({ kind: 'direct', marketId: '1', taker, makers, fills: makers.map(() => '10000000'), takerFill: '100000000' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const d = decodeMatch(out.data)!;
    expect(d.makers.map((m) => m.salt)).toEqual(makers.map((m) => BigInt(m.order.salt)));
    expect(d.makerSigs).toEqual(makers.map((m) => m.signature));
    expect(d.takerSig).toBe('0xabcd');
  });

  it('builds nothing when a maker is from another market', () => {
    const taker = rec('directTakerBuy', '0x11');
    const other = rec('mmDirectMakerSellB', '0x22');
    other.hash = `0x${'ab'.repeat(32)}`;
    expect(encodeMatch({ kind: 'direct', marketId: '1', taker, makers: [other], fills: ['1'], takerFill: '1' })).toEqual({ ok: false, reason: 'market_mismatch', hash: other.hash });
  });

  it('decodeMatch refuses other calls and garbage', () => {
    expect(decodeMatch('0x')).toBeNull();
    expect(decodeMatch('0x12345678')).toBeNull();
  });
});

describe('the proposal the market object sends is parsed strictly', () => {
  const good = () => ({
    kind: 'direct',
    marketId: '1',
    taker: { hash: `0x${'11'.repeat(32)}`, signature: '0xaa', bookedAt: NOW_MS, order: { salt: '1', maker: `0x${'22'.repeat(20)}`, marketId: '1', option: 0, isBuy: true, price: 60, size: '10', expiration: '9', nonce: '0' } },
    makers: [{ hash: `0x${'33'.repeat(32)}`, signature: '0xbb', bookedAt: NOW_MS, order: { salt: '2', maker: `0x${'44'.repeat(20)}`, marketId: '1', option: 0, isBuy: false, price: 50, size: '10', expiration: '9', nonce: '0' } }],
    fills: ['10'],
    takerFill: '10',
  });
  it('accepts a well-formed one and refuses each malformation', () => {
    expect(parseProposal(good())).not.toBeNull();
    const bads: ((p: ReturnType<typeof good>) => unknown)[] = [
      (p) => ({ ...p, kind: 'other' }),
      (p) => ({ ...p, makers: [] , fills: [] }),
      (p) => ({ ...p, fills: ['10', '10'] }),
      (p) => ({ ...p, fills: ['010'] }),
      (p) => ({ ...p, takerFill: 10 }),
      (p) => ({ ...p, taker: { ...p.taker, hash: '0x12' } }),
      (p) => ({ ...p, taker: { ...p.taker, signature: '0x' } }),
      (p) => ({ ...p, taker: { ...p.taker, order: { ...p.taker.order, maker: 'x' } } }),
      (p) => ({ ...p, taker: { ...p.taker, order: { ...p.taker.order, size: '-1' } } }),
      (p) => ({ ...p, taker: { ...p.taker, order: { ...p.taker.order, price: 'x' } } }),
      (p) => ({ ...p, taker: { ...p.taker, bookedAt: undefined } }),
      (p) => ({ ...p, taker: { ...p.taker, bookedAt: '1' } }),
      (p) => ({ ...p, makers: [{ ...p.makers[0], bookedAt: -1 }] }),
      (p) => ({ ...p, makers: [{ ...p.makers[0], bookedAt: 1.5 }] }),
      (p) => ({ ...p, makers: [{ ...p.makers[0], bookedAt: 2 ** 53 }] }),
    ];
    for (const b of bads) expect(parseProposal(b(good()))).toBeNull();
    expect(parseProposal(null)).toBeNull();
  });
});

describe('call traces', () => {
  const EX = '0xe8c0000000000000000000000000000000000001' as Hex;
  const SAFE = `0x${'5a'.repeat(20)}` as Hex;
  const OP = `0x${'0b'.repeat(20)}` as Hex;
  const frame = (over: object) => ({ type: 'CALL', from: EX, to: SAFE, input: '0x1626ba7e00', output: '0x', gas: '0x1', gasUsed: '0x1', ...over });
  // exchange -> Safe proxy -> (delegate) singleton -> handler -> (proxy again -> singleton) and ecrecover
  const good = {
    type: 'CALL', from: OP, to: EX, input: '0x', calls: [
      frame({ type: 'STATICCALL', calls: [{ type: 'DELEGATECALL', from: SAFE, to: SAFE_SINGLETON, input: '0x1626ba7e', calls: [
        { type: 'CALL', from: SAFE, to: SAFE_4337_MODULE, input: '0x1626ba7e', calls: [
          { type: 'STATICCALL', from: SAFE_4337_MODULE, to: SAFE, input: '0xf698da25', calls: [{ type: 'DELEGATECALL', from: SAFE, to: SAFE_SINGLETON, input: '0xf698da25' }] },
          { type: 'STATICCALL', from: SAFE_4337_MODULE, to: ECRECOVER, input: '0x' },
        ] },
      ] }] }),
    ],
  };

  it('parses a trace and refuses one it cannot read', () => {
    expect(parseTrace(good)?.calls).toHaveLength(1);
    expect(parseTrace(null)).toBeNull();
    expect(parseTrace({ ...good, from: 'x' })).toBeNull();
    expect(parseTrace({ ...good, calls: 'x' })).toBeNull();
    expect(parseTrace({ ...good, calls: [{ type: 'CALL' }] })).toBeNull();
    let deep: object = { type: 'CALL', from: OP, to: EX };
    for (let i = 0; i < 100; i++) deep = { type: 'CALL', from: OP, to: EX, calls: [deep] };
    expect(parseTrace(deep)).toBeNull();
  });

  it('a Safe check frame ran only allowlisted code', () => {
    const top = parseTrace(good)!;
    const frames = checkFrames(top, EX, [SAFE]);
    expect([...frames.get(SAFE)![0].ran].sort()).toEqual([SAFE, SAFE_SINGLETON, SAFE_4337_MODULE, ECRECOVER].sort());
    expect(outsiders(frames.get(SAFE)!, SAFE)).toEqual([]);
    expect(allowedFor(SAFE).size).toBe(4);
  });

  it('names code outside the allowlist, and finds no frame for a party that was not checked', () => {
    const evil = `0x${'ee'.repeat(20)}` as Hex;
    const bad = JSON.parse(JSON.stringify(good));
    bad.calls[0].calls[0].calls[0].calls.push({ type: 'CALL', from: SAFE_4337_MODULE, to: evil, input: '0x' });
    const frames = checkFrames(parseTrace(bad)!, EX, [SAFE]);
    expect(outsiders(frames.get(SAFE)!, SAFE)).toEqual([evil]);
    expect(checkFrames(parseTrace(good)!, EX, [`0x${'77'.repeat(20)}` as Hex]).size).toBe(0);
    // a call to the party by someone other than the exchange is not its check frame
    const other = JSON.parse(JSON.stringify(good));
    other.calls[0].from = OP;
    expect(checkFrames(parseTrace(other)!, EX, [SAFE]).size).toBe(0);
  });

  it('reads the revert a top frame shows, from the exchange ABI', () => {
    const hash = `0x${'ab'.repeat(32)}` as Hex;
    const out = encodeErrorResult({ abi: EXCHANGE_ABI, errorName: 'InsufficientCash', args: [hash] });
    const top = parseTrace({ type: 'CALL', from: OP, to: EX, input: '0x', output: out, error: 'execution reverted' })!;
    expect(topRevert(top)).toEqual({ name: 'InsufficientCash', args: [hash], outOfGas: false });
    expect(topRevert(parseTrace(good)!)).toBeNull();
    const oog = parseTrace({ type: 'CALL', from: OP, to: EX, input: '0x', error: 'out of gas' })!;
    expect(topRevert(oog)).toEqual({ name: null, args: [], outOfGas: true });
    const ig = parseTrace({ type: 'CALL', from: OP, to: EX, input: '0x', output: encodeErrorResult({ abi: EXCHANGE_ABI, errorName: 'InsufficientGas' }), error: 'execution reverted' })!;
    expect(topRevert(ig)?.outOfGas).toBe(true);
    const junk = parseTrace({ type: 'CALL', from: OP, to: EX, input: '0x', output: '0x4e487b710000000000000000000000000000000000000000000000000000000000000011', error: 'execution reverted' })!;
    // viem names the standard Panic(uint256); it is not one of the exchange's errors, so the settler treats it as unknown
    expect(topRevert(junk)).toEqual({ name: 'Panic', args: [17n], outOfGas: false });
  });
});
