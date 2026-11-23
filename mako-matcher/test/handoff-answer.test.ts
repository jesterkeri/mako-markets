// Codex MATCHER R6 F2: the intake response says what the settler answered to the hand-off (accepted, refused, or
// unknown when the answer was lost), next to `handedOff`. F3: a refusal from the REAL settler route (configured, with
// today's refusal in its storage) reaches the market as an explicit refusal and releases its marks.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { generatePrivateKey } from 'viem/accounts';
import type { Env } from '../src/env';
import { handoffAnswer } from '../src/market';
import { MatcherSettler, utcDay } from '../src/settler';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

async function place(name: string) {
  const v = vec(name);
  fund(h.w, v.order, 500_000_000n);
  return h.place(v);
}
const marks = async () => (await h.sql<{ in_flight: number }>(`SELECT in_flight FROM orders ORDER BY seq`)).map((r) => (r.in_flight > 0 ? 1 : 0));

describe('Codex MATCHER R6 F2: the intake response names the hand-off answer', () => {
  it('no crossing order: nothing handed off, no answer', async () => {
    expect((await place('directMakerSell')).json).toMatchObject({ ok: true, booked: true, handedOff: 0, handoff: null });
  });

  it('accepted: both orders stay marked', async () => {
    await place('directMakerSell');
    h.settleAccepts = true;
    expect((await place('directTakerBuy')).json).toMatchObject({ handedOff: 1, handoff: 'accepted' });
    expect(await marks()).toEqual([1, 1]);
  });

  it('an explicit refusal: marks released', async () => {
    await place('directMakerSell');
    expect((await place('directTakerBuy')).json).toMatchObject({ handedOff: 1, handoff: 'refused' });
    expect(await marks()).toEqual([0, 0]);
  });

  it('a lost answer: unknown, marks kept (the settler may hold the proposal)', async () => {
    await place('directMakerSell');
    h.deps.settle = async () => {
      throw new Error('lost');
    };
    expect((await place('directTakerBuy')).json).toMatchObject({ handedOff: 1, handoff: 'unknown' });
    expect(await marks()).toEqual([1, 1]);
    expect((await h.alerts()).map((a) => a.code)).toContain('handoff_unconfirmed');
  });
});

describe('Codex MATCHER R6 F3: the real settler route refuses a hand-off naming an account refused today', () => {
  // A configured settler: K and the funder set, and a throwaway key generated here (it controls nothing).
  const configured: Partial<Env> = { K: '5', FUNDER_ADDRESS: '0x' + 'f0'.repeat(20), OPERATOR_PRIVATE_KEY: generatePrivateKey() };
  const settlerStub = () => env.SETTLER.get(env.SETTLER.idFromName('settler'));

  it('503 party_refused through the HTTP route, read as an explicit refusal; the market releases its marks; nothing pending', async () => {
    const maker = vec('directMakerSell').order.maker;
    await runInDurableObject(settlerStub(), (_i, state) => {
      // excluded on the day the market books the order (the settler checks each order's booking time, Codex R7 F2)
      state.storage.sql.exec('INSERT OR REPLACE INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', maker, utcDay(h.w.nowMs), 'bad_signature', 1);
    });
    const answers: { status: number; text: string }[] = [];
    // the market's settle dependency, as realDeps builds it, against the configured settler object
    h.deps.settle = async (body) =>
      runInDurableObject(settlerStub(), async (_i, state) => {
        const res = await new MatcherSettler(state, { ...env, ...configured } as Env).fetch(
          new Request('https://settler/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        );
        const text = await res.text();
        answers.push({ status: res.status, text });
        return handoffAnswer(text);
      });
    try {
      await place('directMakerSell'); // the market's list (h.refused) does not name it: a stale read
      const r = await place('directTakerBuy');
      expect(answers).toHaveLength(1);
      expect(answers[0].status).toBe(503);
      expect(JSON.parse(answers[0].text)).toEqual({ ok: false, accepted: false, error: 'party_refused' });
      expect(r.json).toMatchObject({ handedOff: 1, handoff: 'refused' });
      expect(await marks()).toEqual([0, 0]);
      await runInDurableObject(settlerStub(), (_i, state) => {
        expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM pending').one().n).toBe(0);
      });
      // control: the same configured route with the refusal removed accepts the proposal it was given
      await runInDurableObject(settlerStub(), (_i, state) => {
        state.storage.sql.exec('DELETE FROM refused_accounts');
      });
      await h.tick();
      expect(answers.at(-1)?.status).toBe(200);
      expect(await marks()).toEqual([1, 1]);
    } finally {
      await runInDurableObject(settlerStub(), async (_i, state) => {
        for (const t of ['refused_accounts', 'pending']) state.storage.sql.exec(`DELETE FROM ${t}`);
        await state.storage.deleteAlarm();
      });
    }
  });
});
