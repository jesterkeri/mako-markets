// The root release guard (naming plan r8 §7.10, §8 "Root guard"; owner decision 2026-10-22): the app loads only for a
// Mako pools deployment with a reviewed, code-pinned record (src/lib/mako-release-record.ts). For any other
// NEXT_PUBLIC_MAKO_ADDRESS, contract.ts throws when it loads, so no title, rules card, bet gate, create, share,
// signature, sponsorship request or send exists for that contract, and instrumentation's register() rejects, so a
// server never takes a request. Same pattern as contract-address-normalization.test.ts (reset, set env, import()).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

import fixture from './fixtures/v4-price-pools-0-151.json';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@sentry/nextjs', () => ({ init: vi.fn(), captureRequestError: vi.fn() }));

const V4 = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const SAVED = { address: process.env.NEXT_PUBLIC_MAKO_ADDRESS, block: process.env.NEXT_PUBLIC_MAKO_DEPLOY_BLOCK };
const setEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

function withEnv(address: string | undefined, block?: string) {
  vi.resetModules();
  setEnv('NEXT_PUBLIC_MAKO_ADDRESS', address);
  setEnv('NEXT_PUBLIC_MAKO_DEPLOY_BLOCK', block);
}

afterEach(() => {
  setEnv('NEXT_PUBLIC_MAKO_ADDRESS', SAVED.address);
  setEnv('NEXT_PUBLIC_MAKO_DEPLOY_BLOCK', SAVED.block);
  vi.resetModules();
});

const NOT_REVIEWED = /is not a reviewed Mako Market deployment/;

// Every module on the paths Codex R4 named: titles, rules card, bet gate, create, share, hooks, the tx hook, and the
// sponsor and send routes.
const LOADERS: [string, () => Promise<unknown>][] = [
  ['contract', () => import('@/lib/contract')],
  ['pool-display', () => import('@/lib/pool-display')],
  ['pool-rules', () => import('@/lib/pool-rules')],
  ['pool-bet-rules', () => import('@/lib/pool-bet-rules')],
  ['pool-create', () => import('@/lib/pool-create')],
  ['pool-share', () => import('@/lib/pool-share')],
  ['hooks', () => import('@/lib/hooks')],
  ['use-pool-tx', () => import('@/lib/use-pool-tx')],
  ['sponsor route', () => import('@/app/api/aa/sponsor/route')],
  ['send route', () => import('@/app/api/aa/send/route')],
  // The request boundary: Next awaits Proxy before every page and route, including ones that never import contract.ts.
  ['proxy', () => import('@/proxy')],
];

describe('root guard 1: an unreviewed address loads nothing', () => {
  for (const address of ['0x0000000000000000000000000000000000000001', '0xf9853d7ad6601deF4367524A5802B41227ea5c43']) {
    for (const [name, load] of LOADERS) {
      it(`${address}: ${name} does not load`, async () => {
        withEnv(address);
        await expect(load()).rejects.toThrow(NOT_REVIEWED);
      });
    }
    it(`${address}: instrumentation register() rejects, so the server takes no request`, async () => {
      withEnv(address);
      const { register } = await import('@/instrumentation');
      await expect(register()).rejects.toThrow(NOT_REVIEWED);
    });
  }

  it('the proxy lets every request through for the V4 record (Codex naming code review R1 F1)', async () => {
    withEnv(V4, '32603678');
    const { proxy, config } = await import('@/proxy');
    expect(proxy().headers.get('x-middleware-next')).toBe('1');
    // No matcher gap for pages or API routes: only build assets are left out.
    expect(config.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)']);
  });

  it('register() resolves for the V4 record', async () => {
    withEnv(V4, '32603678');
    const { register } = await import('@/instrumentation');
    await expect(register()).resolves.toBeUndefined();
  });
});

describe('root guard 2: the chain is pinned too', () => {
  it('the V4 address on another chain, or with no records, is refused', async () => {
    withEnv(undefined);
    const { resolveMakoRelease } = await import('@/lib/contract');
    expect(() => resolveMakoRelease(84532, V4, undefined)).toThrow(NOT_REVIEWED);
    expect(() => resolveMakoRelease(10143, V4, undefined, [])).toThrow(NOT_REVIEWED);
  });
});

describe('root guard 3: the deploy block, when set, must be the record\'s', () => {
  for (const block of ['1', '032603678', '0']) {
    it(`refuses ${JSON.stringify(block)}`, async () => {
      withEnv(V4, block);
      await expect(import('@/lib/contract')).rejects.toThrow(/NEXT_PUBLIC_MAKO_DEPLOY_BLOCK/);
    });
  }
  for (const block of [undefined, '', '32603678', ' 32603678\n']) {
    it(`loads with ${JSON.stringify(block)}`, async () => {
      withEnv(V4, block);
      const c = await import('@/lib/contract');
      const r = await import('@/lib/mako-release-record');
      expect(c.MAKO_RELEASE).toBe(r.MAKO_RELEASES[0]);
    });
  }
});

describe('root guard 4: the V4 forms load', () => {
  for (const address of [undefined, `${V4}\n`, `  ${V4}  `, V4.toLowerCase()]) {
    it(`${JSON.stringify(address)} gives the V4 record`, async () => {
      withEnv(address);
      const c = await import('@/lib/contract');
      const r = await import('@/lib/mako-release-record');
      expect(c.MAKO_ADDRESS).toBe(V4);
      expect(c.MAKO_RELEASE).toBe(r.MAKO_RELEASES[0]);
    });
  }
});

describe('root guard 5: the record', () => {
  it('has exactly the reviewed V4 entry', async () => {
    const { MAKO_RELEASES } = await import('@/lib/mako-release-record');
    expect(MAKO_RELEASES).toHaveLength(1);
    const r = MAKO_RELEASES[0];
    expect(getAddress(r.address)).toBe(r.address);
    expect(r).toMatchObject({
      chainId: 10143,
      address: V4,
      deployBlock: 32603678,
      deployTx: '0x820d7d68d9bf1bf54aa15cd33370e8baac6bd7e57b0670509a26f137ced39740',
      sourceCommit: 'd088ced7afe43b1056fb4b08298931ea795932c2',
      dsSince: { crypto: 1_791_901_440, rwa: 1_792_108_800 },
    });
    // A measured hash, never a placeholder.
    expect(r.runtimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    const built = [93, 101, 103, 109, 114, 118, 122, 123, 124, 126, 127, 129, 130, 136, 137, 138, 140, 142, 143, 145, 147, 149, 150, 151];
    expect(Object.keys(r.vettedWording).map(Number).sort((a, b) => a - b)).toEqual(built);
    for (const id of built) expect(r.vettedWording[id]).toBe(fixture.pools.find((p) => p.id === id)!.question);
  });

  it('guard messages: no dashes, no we/our/us, the brand singular', async () => {
    withEnv(undefined);
    const { resolveMakoRelease } = await import('@/lib/contract');
    const messages: string[] = [];
    for (const call of [() => resolveMakoRelease(84532, V4, undefined), () => resolveMakoRelease(10143, V4, '1')]) {
      try {
        call();
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m).toContain('Mako Market will not load.');
      expect(m).not.toMatch(/[–—]/);
      expect(m).not.toMatch(/\b(we|our|us)\b/i);
      expect(m).not.toMatch(/Mako Markets/);
    }
  });
});
