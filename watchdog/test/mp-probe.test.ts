// The market-page probe after the 2026-10-08 redesign (Joshua: a false "market page: title missing" critical). It
// loads /pools/74 and matches the market's title as a prefix, so the site's name after it does not matter, while a
// page without the market's own title still fails.
import { describe, expect, it } from 'vitest';

import { makeNet } from '../src/net';
import { probeMarketPage } from '../src/probes';

const APP = 'https://makomarket.xyz';
const net = (body: string, status = 200, seen: string[] = []) =>
  makeNet(
    (async (url: string) => {
      seen.push(url);
      return new Response(body, { status });
    }) as typeof fetch,
    () => 0,
    async () => {},
    60_000,
    10,
  );

describe('mp probe', () => {
  it('passes with the site name the redesign uses, and with the old one', async () => {
    for (const site of ['Mako Market Beta', 'Mako Market']) {
      const seen: string[] = [];
      const r = await probeMarketPage(net(`<html><title>Will ETH close below $1,827 in 3 days? · ${site}</title></html>`, 200, seen), APP);
      expect(r, site).toEqual({ code: 'mp', obs: 'ok', detail: '' });
      expect(seen[0]).toBe(`${APP}/pools/74`);
    }
  });

  it('fails when the page lacks the market title, or answers an error', async () => {
    expect((await probeMarketPage(net('<html><title>Pool · Mako Market Beta</title></html>'), APP)).detail).toBe('market page: title missing');
    expect((await probeMarketPage(net('oops', 500), APP)).obs).toBe('fail');
  });
});
