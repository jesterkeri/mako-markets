// Adversary pass on c81457a (spec 5: masking never corrupts a field Sentry needs to symbolicate an event; spec 1: every
// envelope stays valid). Real @sentry/nextjs 11.4.0 BROWSER SDK (build/cjs/index.client.js, the build the
// `browser` export condition picks for require) under happy-dom, production options from sentryBaseOptions(), a capturing
// transport. Only sampling is changed. One Sentry.init per file. `.tsx` only so vitest.config.ts runs it under
// happy-dom; it renders nothing.
//
// What the SDK does with a frame whose script has a debug ID (paths under node_modules/.pnpm/):
//   @sentry+core@11.4.0/.../core/build/esm/utils/debug-ids.js:8-55       `_sentryDebugIds` (written by the snippet
//       the Sentry bundler plugin injects into every uploaded chunk) maps the chunk's stack-trace filename, query
//       included, to its debug ID.
//   @sentry+core@11.4.0/.../core/build/esm/utils/prepareEvent.js:94-102  applyDebugIds tags each frame with that ID.
//   @sentry+nextjs@11.4.0_*/.../nextjs/build/esm/client/clientNormalizationIntegration.js:34-36  the frame's
//       `https://<origin>` becomes `app://`, so the filename is `app:///_next/static/chunks/<chunk>.js?dpl=<id>`.
//   @sentry+core@11.4.0/.../core/build/esm/utils/prepareEvent.js:104-130 applyDebugMeta then moves the ID into
//       `debug_meta.images[]` as `{ type: "sourcemap", code_file: <that same frame filename>, debug_id }`. The
//       image is keyed by the frame's own path string, so the frame and its image must still name the same file
//       after masking. (Sentry's server-side lookup of a frame's image is not in this repo and was not read.)
// Why the chunk URL has a query (paths under node_modules/.pnpm/next@16.2.3_*/node_modules/next/dist/):
//   esm/server/app-render/get-asset-query-string.js:13-14  every App Router script gets `?dpl=<clientAssetToken>`
//       when a deployment ID is set; esm/server/config.js:646-647 sets it from NEXT_DEPLOYMENT_ID (set on Vercel
//       when Skew Protection is on, per Vercel's docs, not verified here). Lines 9-11: `?v=<timestamp>` in webpack dev.
// The chunk name and deployment ID below have the shape Next and Vercel produce; neither names a real deployment.
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { sentryBaseOptions } from '@/lib/sentry-options';

// The CommonJS build of the same browser entry: its ESM twin imports `next/router` without an extension, which Node's
// ESM loader refuses outside a bundler.
const Sentry = createRequire(import.meta.url)('../../../node_modules/@sentry/nextjs/build/cjs/index.client.js') as typeof import('@sentry/nextjs');

type Frame = { filename?: string; abs_path?: string };
type Image = { type: string; code_file: string; debug_id: string };
type WireEvent = {
  exception?: { values?: { stacktrace?: { frames?: Frame[] } }[] };
  debug_meta?: { images?: Image[] };
};

const CHUNK = 'https://makomarket.xyz/_next/static/chunks/0f3a9c1d2b4e5a6f.js?dpl=dpl_7Hq2xLmN4pQrStUv';
const DEBUG_ID = '5b1c2d3e-4f50-4617-8899-aabbccddeeff';
const events: WireEvent[] = [];

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/1');
  // The snippet the bundler plugin injects: `new Error().stack` taken inside the chunk, mapped to its debug ID.
  (globalThis as { _sentryDebugIds?: Record<string, string> })._sentryDebugIds = {
    [`Error\n    at ${CHUNK}:1:120`]: DEBUG_ID,
  };
  Sentry.init({
    ...sentryBaseOptions(),
    sampleRate: 1,
    tracesSampleRate: 0,
    transport: () => ({
      send: async (envelope: unknown) => {
        const [, items] = envelope as [unknown, [{ type: string }, unknown][]];
        for (const [header, payload] of items) {
          if (header.type === 'event') events.push(JSON.parse(JSON.stringify(payload)) as WireEvent);
        }
        return {};
      },
      flush: async () => true,
    }),
  } as Parameters<typeof Sentry.init>[0]);
});

describe('spec 5: a browser frame from a Next chunk keeps its link to the uploaded source map', () => {
  it('every sourcemap image code_file is the filename of a frame in the same event', async () => {
    const err = new Error('chunk threw');
    err.stack = `Error: chunk threw\n    at onClick (${CHUNK}:1:2345)`;
    Sentry.captureException(err);
    await Sentry.flush(2000);

    expect(events.length).toBe(1); // the event was sent
    const event = events[0];
    const frames = event.exception?.values?.flatMap((v) => v.stacktrace?.frames ?? []) ?? [];
    const images = (event.debug_meta?.images ?? []).filter((i) => i.type === 'sourcemap');
    expect(images.map((i) => i.debug_id)).toEqual([DEBUG_ID]); // the SDK did attach the debug ID

    // applyDebugMeta keys the image by the frame's abs_path, else its filename: the two must still be one string.
    const framePaths = frames.map((f) => f.abs_path ?? f.filename);
    expect(framePaths).toEqual(expect.arrayContaining(images.map((i) => i.code_file)));
  });
});
