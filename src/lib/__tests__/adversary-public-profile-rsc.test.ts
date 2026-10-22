// Adversary (13a public profile, 2026-10-17): /u/[address] is a Server Component, so Next renders it with the React
// Flight server, which serialises every prop handed to a 'use client' component. public-profile.test.tsx calls the
// page as a plain function and renders it with the browser React, which never serialises anything, so it cannot see
// a prop the Flight server refuses.
//
// This test renders the real page with Next's own vendored Flight server (next/dist/compiled/react-server-dom-webpack,
// the copy `next start` uses) and the react-server build of React. Every module the page reaches that starts with
// 'use client' is swapped for client references, exactly what Next's bundler does with that directive; the scan
// is generic, so a fix that moves the Copy button into a new client module is handled the same way. The data comes
// from the leaderboard's pglite harness, as in public-profile.test.tsx; only Next's cache and notFound are stubbed.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makoMarketEvents } from '@/db/schema';
import { createTestDb, type TestDb } from '@/lib/leaderboard/__tests__/test-db';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => Promise<unknown>) => fn }));
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

// ---- the react-server React + Next's Flight server ------------------------------------------------------------
const req = createRequire(import.meta.url);
const flightPath = req.resolve('next/dist/compiled/react-server-dom-webpack/server.node.js');
const flightReq = createRequire(flightPath);
const nextReq = createRequire(req.resolve('next/package.json'));
// The Flight server (and the react-server react-dom build) require bare "react" / "react-dom"; Next's runtime points
// those at the react-server builds, so do the same in the require cache before either is loaded.
const cache = req.cache as Record<string, unknown>;
const inject = (resolved: string, exports: unknown) => {
  cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const serverReact = nextReq('next/dist/compiled/react/react.react-server.js');
const domServerPath = nextReq.resolve('next/dist/compiled/react-dom/react-dom.react-server.js');
inject(flightReq.resolve('react'), serverReact);
inject(createRequire(domServerPath).resolve('react'), serverReact);
inject(createRequire(domServerPath).resolve('next/dist/compiled/react'), serverReact);
inject(flightReq.resolve('react-dom'), nextReq(domServerPath));
// The page itself is compiled against react/jsx-dev-runtime; on Next's server layer that is the react-server runtime.
for (const rt of ['jsx-dev-runtime', 'jsx-runtime'] as const) {
  inject(req.resolve(`react/${rt}`), nextReq(`next/dist/compiled/react/${rt}.react-server.js`));
}
const Flight = flightReq(flightPath) as {
  renderToReadableStream: (model: unknown, config: unknown, opts: { onError: (e: unknown) => void }) => ReadableStream;
  registerClientReference: (impl: unknown, id: string, name: string) => unknown;
};

// ---- 'use client' modules reachable from the page, found the way the bundler finds them ------------------------
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
      return; // its own imports run in the browser
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
    refs[name] =
      typeof value === 'function'
        ? Flight.registerClientReference(() => {
            throw new Error(`client component ${name} called on the server`);
          }, id, name)
        : value;
  }
  vi.doMock(file, () => refs);
}

const { default: PlayerPage } = await import('@/app/u/[address]/page');

// ---- fixture: the same ledger shape public-profile.test.tsx uses ---------------------------------------------
const WALLET = '0x000000000000000000000000000000000000b22d';
let t: TestDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function seed() {
  t = await createTestDb();
  currentDb = t.db;
  // users + user_safes stubs come from the leaderboard harness (#214: 0020's triggers name them).
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

async function flight(model: unknown): Promise<{ errors: string[]; payload: string }> {
  const errors: string[] = [];
  const stream = Flight.renderToReadableStream(model, manifest, {
    onError: (e) => {
      errors.push(e instanceof Error ? e.message : String(e));
    },
  });
  const payload = await new Response(stream).text();
  return { errors, payload };
}

describe('/u/[address] under the React Flight server (what `next start` runs)', () => {
  it('the page reaches at least one client component (sanity: the scan found the Copy button module)', () => {
    expect(Object.keys(manifest)).toContain('/app/me/MeParts.tsx');
  });

  it('a ranked player profile serialises with no Flight error', async () => {
    await seed();
    const tree = await PlayerPage({ params: Promise.resolve({ address: WALLET }) });
    const { errors } = await flight(tree);
    expect(errors).toEqual([]);
  });
});
