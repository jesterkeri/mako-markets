// CHARTS_DS_PLAN 3.3: RULES_VERSION is sha256 over RULES_REV, the resolver's decoder file and both feed tables. This
// recomputes it from the files themselves, so a change to any of them without `pnpm rules-version` fails here (and the
// generator's --check fails the bundle step).
import { describe, expect, it } from 'vitest';

import ds from '../../cf-worker/src/datastreams.ts?raw';
import cryptoFeeds from '../../cf-worker/src/crypto-feeds.json?raw';
import rwaFeeds from '../../cf-worker/src/rwa-feeds.json?raw';
import { RULES_REV } from '../src/rules';
import { RULES_VERSION } from '../src/rules-version';
import { FEEDS } from '../src/feeds';

const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('');

describe('rules version', () => {
  it('equals sha256(RULES_REV, sha256(datastreams.ts), sha256(crypto-feeds.json), sha256(rwa-feeds.json))', async () => {
    const parts = await Promise.all([ds, cryptoFeeds, rwaFeeds].map(sha));
    expect(RULES_VERSION).toBe(await sha([RULES_REV, ...parts].join('\n')));
  });
  it('the recorder follows exactly the resolver feed tables: 34 feeds, 10 v3 and 24 v8, ids unique', () => {
    expect(FEEDS.length).toBe(34);
    expect(FEEDS.filter((f) => f.schema === 3).length).toBe(10);
    expect(FEEDS.filter((f) => f.schema === 8).length).toBe(24);
    expect(new Set(FEEDS.map((f) => f.feedId)).size).toBe(34);
  });
});
