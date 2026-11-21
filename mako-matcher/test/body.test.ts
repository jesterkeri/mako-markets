import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { readBody } from '../src/body';
import worker from '../src/index';
import type { Env } from '../src/env';
import { fresh } from './harness';

/// A request whose body stream counts how often it is read.
function counted(chunks: string[], headers: Record<string, string> = {}) {
  const state = { pulls: 0 };
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>(
    {
    pull(c) {
      state.pulls++;
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
  }, { highWaterMark: 0 });
  const req = new Request('https://matcher.test/market/1/orders', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  return { req, state };
}

describe('request bodies', () => {
  it('a declared length over the limit is refused before a byte is read', async () => {
    const { req, state } = counted(['{}'], { 'content-length': '9000' });
    expect(await readBody(req)).toEqual({ ok: false });
    expect(state.pulls).toBe(0);
  });
  it('a malformed or negative declared length is refused too', async () => {
    for (const v of ['abc', '-1', '1e3', '']) {
      const { req, state } = counted(['{}'], { 'content-length': v });
      expect(await readBody(req), v).toEqual({ ok: false });
      expect(state.pulls).toBe(0);
    }
  });
  it('a body without a length is cut off at the limit, reading no more than needed', async () => {
    const { req, state } = counted(['x'.repeat(5000), 'x'.repeat(5000), 'x'.repeat(5000), 'x'.repeat(5000)]);
    expect(await readBody(req, 8192)).toEqual({ ok: false });
    expect(state.pulls).toBeLessThanOrEqual(3);
  });
  it('a small body is read whole, multi-byte text intact, and exactly the limit passes', async () => {
    const { req } = counted(['{"a":"é', '€"}']);
    expect(await readBody(req)).toEqual({ ok: true, text: '{"a":"é€"}' });
    const edge = counted(['x'.repeat(8192)]);
    expect((await readBody(edge.req)).ok).toBe(true);
    const over = counted(['x'.repeat(8193)]);
    expect((await readBody(over.req)).ok).toBe(false);
  });

  it('the Worker answers 413 to an oversized declared length without reading the body', async () => {
    const { req, state } = counted(['{}'], { 'content-length': '9000' });
    const r = await worker.fetch(req, env as Env);
    expect(r.status).toBe(413);
    expect(state.pulls).toBe(0);
  });

  it('the market object does the same, for orders and for the settler\'s report', async () => {
    const h = await fresh('1');
    for (const path of ['/orders', '/outcome']) {
      const res = await h.call('POST', path, { body: { pad: 'x'.repeat(9000) } });
      expect(res.status, path).toBe(413);
    }
    // and with a declared length, without the body being read
    const { runInDurableObject } = await import('cloudflare:test');
    const { handleRequest } = await import('../src/market');
    const out = await runInDurableObject(h.stub, async (_i, state) => {
      const { req, state: s } = counted(['{}'], { 'content-length': '9000', 'x-market-id': '1' });
      const r = await handleRequest(state, env as Env, new Request('https://market/orders', { method: 'POST', body: req.body, headers: req.headers, duplex: 'half' } as RequestInit), h.deps);
      return { status: r.status, pulls: s.pulls };
    });
    expect(out).toEqual({ status: 413, pulls: 0 });
  });
});
