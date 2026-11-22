// Fifth adversary round, hand-off. The settler's real /settle handler against the market's `handoffAnswer`:
// every answer the handler can give must be read as the settler meant it.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/env';
import { handoffAnswer } from '../src/market';
import { MatcherSettler } from '../src/settler';
import { DIRECT } from './settle-helpers';

async function viaRealSettler(body: unknown, e: Partial<Env> = {}) {
  return runInDurableObject(env.SETTLER.get(env.SETTLER.idFromName('settler')), async (_i, state) => {
    const inst = new MatcherSettler(state, { ...env, ...e } as Env);
    const res = await inst.fetch(new Request('https://settler/settle', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, text: await res.text() };
  });
}

describe('adv5: the settler handler answers are all readable by handoffAnswer', () => {
  it('a refusal (K unset), a bad proposal and a missing primary RPC or exchange are explicit refusals', async () => {
    const cases: [unknown, Partial<Env>][] = [
      [DIRECT(), {}],
      [{ nonsense: true }, {}],
      [DIRECT(), { PRIMARY_RPC_URL: undefined }],
      [DIRECT(), { EXCHANGE_ADDRESS: undefined }],
    ];
    for (const [b, e] of cases) {
      const r = await viaRealSettler(b, e);
      expect(handoffAnswer(r.text), r.text).toEqual({ accepted: false });
    }
  });
});
