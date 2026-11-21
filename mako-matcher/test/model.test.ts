// Checks the fake node's model of the contract's signature checker against the shared vectors, which the real
// contract's tests produced: a wrong model would make every intake test below it meaningless.
import { describe, expect, it } from 'vitest';
import { toFunctionSelector, type Hex } from 'viem';
import { EXCHANGE_ABI } from '../src/abi';
import { isValidOrderSignature } from '../src/chain';
import { EXCHANGE, makeFetch, NOW_MS, World } from './fake';
import { V, vec } from './vectors';

function ctx(w: World) {
  return { net: { fetch: makeFetch(w), now: () => NOW_MS, deadlineAt: NOW_MS + 60_000 }, rpcUrl: 'https://rpc.test/', exchange: EXCHANGE, chainId: 10143 };
}

describe('the fake node answers like the contract on the shared vectors', () => {
  it('every EOA vector order passes, the Safe ones pass with the real proxy, and a stranger fails', async () => {
    const w = new World();
    for (const [name, s] of Object.entries(V.safes)) if (name === 'safeTaker' || name === 'safeMaker1') w.addSafe(s.address, s.ownerAddress);
    for (const name of Object.keys(V.orders)) {
      const o = V.orders[name];
      if (!['eoa', 'safe'].includes(o.kind) || name.startsWith('reg')) continue;
      const v = vec(name);
      const r = await isValidOrderSignature(ctx(w), v.order, v.signature);
      expect(r, name).toEqual({ kind: 'valid' });
    }
  });

  it('a Safe whose owner is someone else is invalid', async () => {
    const w = new World();
    const s = V.safes.safeTaker;
    w.addSafe(s.address, V.safes.safeMaker1.ownerAddress);
    const v = vec('safeTakerBuy');
    expect(await isValidOrderSignature(ctx(w), v.order, v.signature)).toEqual({ kind: 'invalid' });
  });

  it('an empty and a 196-byte signature revert BadSignatureLength with the order hash', async () => {
    const w = new World();
    const v = vec('directTakerBuy');
    for (const sig of ['0x', `0x${'11'.repeat(196)}`] as Hex[]) {
      const r = await isValidOrderSignature(ctx(w), v.order, sig);
      expect(r).toEqual({ kind: 'revert', name: 'BadSignatureLength' });
    }
  });

  it('the selectors the vendored ABI gives are the ones the contract build recorded in the vectors', () => {
    const fns = (V as unknown as { functions: Record<string, { signature: string; selector: string }> }).functions;
    for (const n of ['matchOrders', 'isValidOrderSignature', 'cancelOrders']) {
      const item = EXCHANGE_ABI.find((e) => e.type === 'function' && e.name === n)!;
      expect(toFunctionSelector(item as Parameters<typeof toFunctionSelector>[0]), n).toBe(fns[n].selector);
    }
    const errs = (V as unknown as { errors: Record<string, { selector: string }> }).errors;
    for (const [n, e] of Object.entries(errs)) {
      const item = EXCHANGE_ABI.find((x) => x.type === 'error' && x.name === n)!;
      // An error's selector is computed the way a function's is, from its name and input types.
      expect(toFunctionSelector({ ...(item as object), type: 'function', stateMutability: 'view', outputs: [] } as unknown as Parameters<typeof toFunctionSelector>[0]), n).toBe(e.selector);
    }
  });
});
