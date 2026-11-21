import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { parseOrderBody, orderHash, recoverStrict, isSafeFormSignature, canonicalUint } from '../src/order';
import { SAFE_PROXY_CODE_HASH, SAFE_4337_MODULE, SAFE_SINGLETON, SAFE_FACTORY, FALLBACK_HANDLER_SLOT, classifyCode, isSupportedSafe } from '../src/wallets';
import { body, toTuple, V, vec } from './vectors';
import { HALF_N, SAFE_PROXY_CODE } from './fake';
import { keccak256 } from 'viem';
import factoryHex from '../data/safe-v1.4.1/SafeProxyFactory.hex?raw';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe('order hash against every vector order', () => {
  for (const domain of ['testnet', 'local', 'otherExchange']) {
    const d = V.domains[domain];
    for (const name of Object.keys(V.orders)) {
      it(`${name} under ${domain}`, () => {
        const o = toTuple(V.orders[name].fields);
        const want = V.signed[domain][name].orderHash;
        expect(orderHash(o, { chainId: d.chainId, exchange: d.verifyingContract })).toBe(want);
      });
    }
  }

  it('the typed-data type hashes are the plan values', () => {
    expect(V.types.order.hash).toBe('0x31b03c5451c8432797ca6ddcfd89cc41597b3a6d62728cd13f8bea1090e223cc');
    expect(V.types.eip712Domain.hash).toBe('0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f');
  });
});

describe('strict local recovery (the contract step-1 rules)', () => {
  const eoa = Object.keys(V.orders).filter((n) => V.orders[n].kind === 'eoa');
  for (const name of eoa) {
    it(`recovers ${name}'s maker`, async () => {
      const v = vec(name);
      expect(await recoverStrict(v.hash, v.signature)).toBe(v.order.maker);
    });
  }

  /// The high-s twin: (r, n - s, v flipped) recovers the same address in a lenient library, never in the contract.
  function twin(sig: Hex): Hex {
    const r = sig.slice(2, 66);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = parseInt(sig.slice(130, 132), 16);
    const s2 = (N - s).toString(16).padStart(64, '0');
    return `0x${r}${s2}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
  }

  it('refuses the high-s twin of a real signature', async () => {
    const v = vec('directTakerBuy');
    const t = twin(v.signature);
    expect(BigInt(`0x${t.slice(66, 130)}`)).toBeGreaterThan(HALF_N);
    expect(await recoverStrict(v.hash, t)).toBeNull();
  });

  it('refuses v 0 and v 1 (a lenient library recovers from them)', async () => {
    const v = vec('directTakerBuy');
    const v0 = `${v.signature.slice(0, 130)}${(parseInt(v.signature.slice(130, 132), 16) - 27).toString(16).padStart(2, '0')}` as Hex;
    expect(v0.slice(130)).toMatch(/^0[01]$/);
    expect(await recoverStrict(v.hash, v0)).toBeNull();
  });

  it('refuses other v values, wrong lengths, zero r and zero s', async () => {
    const v = vec('directTakerBuy');
    const base = v.signature.slice(0, 130);
    for (const bad of ['1d', '1f', '20', '00', 'ff']) expect(await recoverStrict(v.hash, `${base}${bad}` as Hex)).toBeNull();
    expect(await recoverStrict(v.hash, v.signature.slice(0, 128) as Hex)).toBeNull(); // 64 bytes (EIP-2098 length)
    expect(await recoverStrict(v.hash, `${v.signature}00` as Hex)).toBeNull(); // 66 bytes
    expect(await recoverStrict(v.hash, '0x' as Hex)).toBeNull();
    expect(await recoverStrict(v.hash, `0x${'00'.repeat(32)}${v.signature.slice(66)}` as Hex)).toBeNull();
    expect(await recoverStrict(v.hash, `0x${v.signature.slice(2, 66)}${'00'.repeat(32)}1b` as Hex)).toBeNull();
  });

  it('a signature for another order recovers some other address, not the maker', async () => {
    const a = vec('directTakerBuy');
    const b = vec('mintTakerBuy0');
    const rec = await recoverStrict(b.hash, a.signature);
    expect(rec).not.toBe(a.order.maker);
  });

  it('a Safe-form signature (v 31 or 32) never recovers locally', async () => {
    const s = vec('safeTakerBuy');
    expect(isSafeFormSignature(s.signature)).toBe(true);
    expect(await recoverStrict(s.hash, s.signature)).toBeNull();
    expect(isSafeFormSignature(vec('directTakerBuy').signature)).toBe(false);
  });
});

describe('the request body parser', () => {
  const v = vec('directTakerBuy');
  it('accepts the vector order and returns it lower-cased', () => {
    const p = parseOrderBody(body(v.order, v.signature));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.order).toEqual(v.order);
  });
  it('refuses non-canonical numbers, wrong types and extra shapes', () => {
    const good = body(v.order, v.signature);
    const bad: unknown[] = [
      null,
      [],
      'x',
      { ...good, signature: 'abc' },
      { ...good, signature: '0xabc' }, // odd length
      { ...good, order: { ...good.order, size: '0100000000' } }, // leading zero
      { ...good, order: { ...good.order, size: '-1' } },
      { ...good, order: { ...good.order, size: 100000000 } }, // number, not string
      { ...good, order: { ...good.order, marketId: '01' } },
      { ...good, order: { ...good.order, marketId: '1 ' } },
      { ...good, order: { ...good.order, expiration: (2n ** 64n).toString() } },
      { ...good, order: { ...good.order, size: (2n ** 128n).toString() } },
      { ...good, order: { ...good.order, salt: (2n ** 256n).toString() } },
      { ...good, order: { ...good.order, option: 1.5 } },
      { ...good, order: { ...good.order, price: '60' } },
      { ...good, order: { ...good.order, isBuy: 1 } },
      { ...good, order: { ...good.order, maker: '0x1234' } },
      { order: good.order },
    ];
    for (const b of bad) expect(parseOrderBody(b).ok, JSON.stringify(b)?.slice(0, 80)).toBe(false);
  });
  it('canonicalUint', () => {
    expect(canonicalUint('0', 5n)).toBe(0n);
    expect(canonicalUint('5', 5n)).toBe(5n);
    expect(canonicalUint('6', 5n)).toBeNull();
    expect(canonicalUint('00', 5n)).toBeNull();
    expect(canonicalUint('+1', 5n)).toBeNull();
  });
});

describe('supported wallet constants come from real files', () => {
  it('the proxy code hash is keccak256 of the derived runtime code', () => {
    expect(keccak256(SAFE_PROXY_CODE)).toBe(SAFE_PROXY_CODE_HASH);
  });
  it('that runtime code is part of the real SafeProxyFactory runtime code', () => {
    expect(factoryHex.trim().toLowerCase().includes(SAFE_PROXY_CODE.slice(2).toLowerCase())).toBe(true);
  });
  it('the singleton, module and factory are the addresses plan 4.6 names, and the vectors agree', () => {
    expect(SAFE_SINGLETON).toBe('0x41675c099f32341bf84bfc5382af534df5c7461a');
    expect(SAFE_4337_MODULE).toBe('0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226');
    expect(SAFE_FACTORY).toBe('0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67');
    for (const s of Object.values(V.safes)) {
      expect(s.singleton.toLowerCase()).toBe(SAFE_SINGLETON);
      expect(s.fallbackHandler.toLowerCase()).toBe(SAFE_4337_MODULE);
    }
  });
  it('the fallback-handler slot is Safe\'s FALLBACK_HANDLER_STORAGE_SLOT', () => {
    expect(FALLBACK_HANDLER_SLOT).toBe('0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5');
  });
  it('classifies code and checks all three facts', () => {
    expect(classifyCode('0x')).toBe('none');
    expect(classifyCode('0xef0100' + 'ab'.repeat(20))).toBe('delegation');
    expect(classifyCode('0x6080')).toBe('contract');
    const word = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;
    expect(isSupportedSafe(SAFE_PROXY_CODE, word(SAFE_SINGLETON), word(SAFE_4337_MODULE))).toBe(true);
    expect(isSupportedSafe(SAFE_PROXY_CODE, word('0x' + '11'.repeat(20)), word(SAFE_4337_MODULE))).toBe(false);
    expect(isSupportedSafe(SAFE_PROXY_CODE, word(SAFE_SINGLETON), word('0x' + '22'.repeat(20)))).toBe(false);
    expect(isSupportedSafe('0x6080', word(SAFE_SINGLETON), word(SAFE_4337_MODULE))).toBe(false);
  });
});
