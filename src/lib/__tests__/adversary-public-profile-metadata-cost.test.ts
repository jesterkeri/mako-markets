// Adversary (13a public profile, round 2, 2026-10-17): one view of /u/[address] must read the ledger once.
//
// Next renders generateMetadata (as the <Metadata> server component) and the page in the SAME Flight render, side by
// side. Both call getPublicProfile(actor). getPublicProfile is Next's unstable_cache, which only helps once an entry
// exists: on a miss it runs the callback and stores the result afterwards, with no in-flight sharing (see
// node_modules/next/dist/server/web/spec-extension/unstable-cache.js, the miss path). So the first view of a profile
// in each minute runs the all-players rank aggregate twice. page.tsx says the ledger is read "cached a minute per
// address in getPublicProfile"; profile.ts says the rank query "aggregates every player". Neon free tier.
//
// This test uses Next's REAL unstable_cache over an in-memory incremental cache (the object Next looks up on
// globalThis when no request store is present; the request-store path has the same miss behaviour), and renders the
// metadata and the page together with Next's vendored Flight server and the react-server React, as `next start`
// does. The data is the leaderboard's pglite harness. Only getCallerRank is wrapped, to count the aggregate.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// These tests import whole route modules afresh (seconds alone); under the full suite's parallel load that passes
// vitest's 5 s default, so they get room. Their assertions are deterministic.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { makoMarketEvents } from '@/db/schema';
import { createTestDb, type TestDb } from '@/lib/leaderboard/__tests__/test-db';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
let currentDb: unknown;
vi.mock('@/db/client', () => ({
  get db() {
    return currentDb;
  },
}));
const rankReads: string[] = [];
vi.mock('@/lib/leaderboard/queries', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/leaderboard/queries')>();
  return {
    ...real,
    getCallerRank: (...args: Parameters<typeof real.getCallerRank>) => {
      rankReads.push(args[1].address);
      return real.getCallerRank(...args);
    },
  };
});

// ---- Next's incremental cache, in memory (the interface unstable_cache calls: generateCacheKey, get, set) --------
// Next's server runtime installs this global before any app code loads (next/dist/server/node-environment).
(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;
type Entry = { value: unknown; isStale: boolean };
const store = new Map<string, unknown>();
(globalThis as unknown as { __incrementalCache: unknown }).__incrementalCache = {
  generateCacheKey: async (k: string) => k,
  get: async (k: string): Promise<Entry | null> => (store.has(k) ? { value: store.get(k), isStale: false } : null),
  set: async (k: string, data: unknown) => {
    store.set(k, data);
  },
};

// ---- the react-server React + Next's Flight server (same wiring as adversary-public-profile-rsc.test.ts) --------
const req = createRequire(import.meta.url);
const flightPath = req.resolve('next/dist/compiled/react-server-dom-webpack/server.node.js');
const flightReq = createRequire(flightPath);
const nextReq = createRequire(req.resolve('next/package.json'));
const cache = req.cache as Record<string, unknown>;
const inject = (resolved: string, exports: unknown) => {
  cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const serverReact = nextReq('next/dist/compiled/react/react.react-server.js') as typeof import('react');
const domServerPath = nextReq.resolve('next/dist/compiled/react-dom/react-dom.react-server.js');
inject(flightReq.resolve('react'), serverReact);
// Server code that imports 'react' (React.cache, for one) gets the react-server build under Next too.
inject(req.resolve('react'), serverReact);
inject(createRequire(domServerPath).resolve('react'), serverReact);
inject(createRequire(domServerPath).resolve('next/dist/compiled/react'), serverReact);
inject(flightReq.resolve('react-dom'), nextReq(domServerPath));
for (const rt of ['jsx-dev-runtime', 'jsx-runtime'] as const) {
  inject(req.resolve(`react/${rt}`), nextReq(`next/dist/compiled/react/${rt}.react-server.js`));
}
const Flight = flightReq(flightPath) as {
  renderToReadableStream: (model: unknown, config: unknown, opts: { onError: (e: unknown) => void }) => ReadableStream;
  registerClientReference: (impl: unknown, id: string, name: string) => unknown;
};

const SRC = resolve('src');
function resolveImport(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? resolve(SRC, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (existsSync(c) && c.match(/\.tsx?$/)) return c;
  return null;
}
function clientModules(entry: string): string[] {
  const seen = new Set<string>();
  const client: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf-8');
    if (/^\s*(\/\/[^\n]*\n\s*)*['"]use client['"]/.test(text)) {
      client.push(file);
      return;
    }
    for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      if (/^import\s+type\s/.test(m[0])) continue;
      const next = resolveImport(m[1], file);
      if (next) walk(next);
    }
  };
  walk(entry);
  return client;
}
const PAGE = resolve('src/app/u/[address]/page.tsx');
const manifest: Record<string, { id: string; chunks: string[]; name: string }> = {};
for (const file of clientModules(PAGE)) {
  const id = file.slice(SRC.length);
  manifest[id] = { id, chunks: [], name: '*' };
  const actual = (await vi.importActual(file)) as Record<string, unknown>;
  const refs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    refs[name] = typeof value === 'function' ? Flight.registerClientReference(() => {}, id, name) : value;
  }
  vi.doMock(file, () => refs);
}

const { default: PlayerPage, generateMetadata } = await import('@/app/u/[address]/page');

// ---- fixture ----------------------------------------------------------------------------------------------
const WALLET = '0x000000000000000000000000000000000000b22d';
let t: TestDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
  store.clear();
  rankReads.length = 0;
});

async function seed() {
  t = await createTestDb();
  currentDb = t.db;
  await t.client.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, wallet_address text, display_name text, avatar_url text);
    CREATE TABLE user_safes (user_id uuid NOT NULL, chain_id integer NOT NULL, safe_address text NOT NULL);
  `);
  // (Builder, Joshua 2026-10-17: only a Mako Market account has a profile, so the player signs in with this wallet.)
  await t.client.query(`INSERT INTO users (wallet_address) VALUES ($1)`, [WALLET]);
  await t.db.insert(makoMarketEvents).values({
    chainId: 10143,
    contractAddress: '0x00000000000000000000000000000000000000aa',
    version: 'v4',
    marketId: '1',
    kind: 'bet',
    actor: WALLET,
    isYes: true,
    amount: '5000000',
    blockNumber: 101,
    blockTimestamp: new Date(),
    txHash: `0x${'1'.padStart(64, '0')}`,
    logIndex: 0,
  });
}

/// One request as Next renders it: the <Metadata> outlet (generateMetadata) and the page in one Flight render.
async function view(address: string): Promise<{ errors: string[]; title: unknown }> {
  const params = Promise.resolve({ address });
  let title: unknown = null;
  async function Metadata() {
    title = (await generateMetadata({ params })).title;
    return null;
  }
  const Page = PlayerPage as unknown as () => Promise<unknown>;
  const model = serverReact.createElement(
    serverReact.Fragment,
    null,
    serverReact.createElement(Metadata),
    serverReact.createElement(Page as never, { params } as never),
  );
  const errors: string[] = [];
  const stream = Flight.renderToReadableStream(model, manifest, {
    onError: (e) => {
      errors.push(e instanceof Error ? e.message : String(e));
    },
  });
  await new Response(stream).text();
  return { errors, title };
}

describe('/u/[address]: ledger reads per profile view (metadata + page in one render)', () => {
  it('sanity: the real unstable_cache serves a second view inside the minute with no new read', async () => {
    await seed();
    await generateMetadata({ params: Promise.resolve({ address: WALLET }) });
    expect(rankReads).toHaveLength(1);
    await generateMetadata({ params: Promise.resolve({ address: WALLET }) });
    expect(rankReads).toHaveLength(1);
  });

  it('the first view of a profile runs the all-players rank aggregate once, not once for the title and once for the page', async () => {
    await seed();
    const { errors, title } = await view(WALLET);
    expect(errors).toEqual([]);
    expect(title).toBe('0x0000…b22d · Mako Market Beta');
    expect(rankReads).toEqual([WALLET]);
  });
});
