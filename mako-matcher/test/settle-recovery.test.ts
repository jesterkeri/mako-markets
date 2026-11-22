// Crashes, restarts and key changes (plan 6.5 "State the settler keeps"): one transaction in flight, never a
// double send, and the outcome always reaches the market.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Hex } from 'viem';
import type { Env } from '../src/env';
import { DIRECT, drive, rows, withSettler } from './settle-helpers';
import { fresh } from './harness';
import { OP, OP2 } from './settle-world';
import { vec } from './vectors';

const inflight = (sql: SqlStorage) => rows<{ n: number }>(sql, 'SELECT COUNT(*) AS n FROM in_flight')[0].n;
const op = OP.address.toLowerCase() as Hex;

describe('a crash between send and receipt', () => {
  it('a restarted settler finds the receipt on the chain and does not send again', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ pending: true });
      await drive(mk(sql), DIRECT(), 1);
      expect(r.w.sent).toHaveLength(1);
      expect(inflight(sql)).toBe(1);
      const hash = r.w.sent[0].hash;
      r.w.receipts.set(hash, { status: 1, effectiveGasPrice: r.w.baseFeePerGas + r.w.prio });
      r.w.confirmedNonce.set(op, 1n);
      const restarted = mk(sql);
      await restarted.run();
      expect(r.w.sent).toHaveLength(1);
      expect(inflight(sql)).toBe(0);
      expect(r.outcomes).toHaveLength(1);
      expect(r.outcomes[0].body.applied).toHaveLength(2);
    });
  });

  it('logged but never broadcast: the same signed bytes go out again (same hash), once', async () => {
    await withSettler(async (sql, r, mk) => {
      let first = true;
      r.over.broadcast = async () => {
        if (first) {
          first = false;
          throw new Error('crash before the node saw it');
        }
        // the second time, hand it to the node as the real broadcast does
        const { rpc } = await import('../src/chain');
        const chain = r.deps(sql).chain;
        const raw = rows<{ raw: Hex }>(sql, 'SELECT raw FROM in_flight')[0].raw;
        await rpc(chain.net, chain.rpcUrl, 'eth_sendRawTransaction', [raw]);
      };
      const s = mk(sql);
      await drive(s, DIRECT(), 1);
      expect(r.w.sent).toHaveLength(0);
      expect(inflight(sql)).toBe(1);
      const logged = rows<{ hash: Hex }>(sql, 'SELECT hash FROM send_log')[0].hash;
      await s.run();
      expect(r.w.sent).toHaveLength(1);
      expect(r.w.sent[0].hash).toBe(logged);
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM send_log')).toEqual([{ n: 1 }]);
      expect(inflight(sql)).toBe(0);
      expect(r.outcomes).toHaveLength(1);
    });
  });

  it('the node took the broadcast but the answer was lost: it is recovered, not sent twice', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ status: 1, rejectSend: true });
      await drive(mk(sql), DIRECT(), 3);
      expect(r.w.sent).toHaveLength(1);
      expect(inflight(sql)).toBe(0);
      expect(r.alerts.map((a) => a.code)).toContain('broadcast_unconfirmed');
      expect(r.outcomes[0].body.applied).toHaveLength(2);
    });
  });

  it('mined between the receipt read and the nonce read: it is settled, never stranded', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ pending: true });
      await drive(mk(sql), DIRECT(), 1);
      const hash = r.w.sent[0].hash;
      // The first receipt read answers "none"; the transaction mines right after it, before the nonce is read.
      const inner = r.w.hooks!;
      let receiptReads = 0;
      r.w.hooks = async (m, p) => {
        const a = await inner(m, p);
        if (m === 'eth_getTransactionReceipt' && ++receiptReads === 1) {
          r.w.receipts.set(hash, { status: 1, effectiveGasPrice: r.w.baseFeePerGas + r.w.prio });
          r.w.confirmedNonce.set(op, 1n);
        }
        return a;
      };
      await mk(sql).run();
      expect(rows(sql, 'SELECT status FROM send_log')).toEqual([{ status: 'settled' }]);
      expect(r.alerts.map((a) => a.code)).not.toContain('stranded_transaction');
      expect(r.outcomes).toHaveLength(1);
      expect(r.outcomes[0].body.applied).toHaveLength(2);
    });
  });

  it('with the same key, a nonce that has passed the logged one with no receipt strands the transaction: its orders go back to the book and its whole reservation stays counted', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ pending: true });
      await drive(mk(sql), DIRECT(), 1);
      const reserved = rows<{ reserved: string }>(sql, 'SELECT reserved FROM send_log')[0].reserved;
      r.w.confirmedNonce.set(op, 1n); // something else used the nonce
      await mk(sql).run();
      expect(inflight(sql)).toBe(0);
      expect(rows(sql, 'SELECT status, charge FROM send_log')).toEqual([{ status: 'stranded', charge: reserved }]);
      expect(r.outcomes[0].body.applied).toBeUndefined();
      expect(r.alerts.map((a) => a.code)).toContain('stranded_transaction');
    });
  });
});

describe('starting with a different key (plan 6.5)', () => {
  async function inFlightUnderOp(sql: SqlStorage, r: Parameters<Parameters<typeof withSettler>[0]>[1], mk: Parameters<Parameters<typeof withSettler>[0]>[2]) {
    r.w.onSend = () => ({ pending: true });
    await drive(mk(sql), DIRECT(), 1);
    r.w.operators.add(OP2.address.toLowerCase() as Hex);
    r.over.key = OP2;
  }

  it('waits while the old key\'s transaction may still land, and builds nothing new', async () => {
    await withSettler(async (sql, r, mk) => {
      await inFlightUnderOp(sql, r, mk);
      const s = mk(sql);
      expect(await s.submit(DIRECT())).toEqual({ accepted: false, reason: 'busy' });
      await s.run();
      await s.run();
      expect(inflight(sql)).toBe(1);
      expect(r.w.sent).toHaveLength(1);
      expect(r.outcomes).toEqual([]);
    });
  });

  it('is released by the old hash\'s receipt', async () => {
    await withSettler(async (sql, r, mk) => {
      await inFlightUnderOp(sql, r, mk);
      r.w.receipts.set(r.w.sent[0].hash, { status: 1, effectiveGasPrice: r.w.baseFeePerGas + r.w.prio });
      await mk(sql).run();
      expect(inflight(sql)).toBe(0);
      expect(r.outcomes[0].body.applied).toHaveLength(2);
    });
  });

  it('or by the old key\'s nonce passing it without one', async () => {
    await withSettler(async (sql, r, mk) => {
      await inFlightUnderOp(sql, r, mk);
      r.w.confirmedNonce.set(op, 1n);
      await mk(sql).run();
      expect(inflight(sql)).toBe(0);
      expect(r.outcomes[0].body.applied).toBeUndefined();
      expect(rows(sql, 'SELECT status FROM send_log')).toEqual([{ status: 'stranded' }]);
    });
  });

  it('or by the exchange no longer listing the old key as an operator (a call logged but never broadcast has no end otherwise)', async () => {
    await withSettler(async (sql, r, mk) => {
      await inFlightUnderOp(sql, r, mk);
      r.w.operators.delete(op);
      await mk(sql).run();
      expect(inflight(sql)).toBe(0);
      expect(r.outcomes).toHaveLength(1);
      // and the new key then settles the next proposal
      r.w.onSend = () => ({ status: 1 });
      await drive(mk(sql), DIRECT());
      expect(r.w.sent.at(-1)!.from).toBe(OP2.address.toLowerCase());
    });
  });
});

describe('what the markets are told', () => {
  it('an outcome a market cannot take yet is kept and delivered later, once', async () => {
    await withSettler(async (sql, r, mk) => {
      let fail = true;
      const base = r.deps(sql).report;
      r.over.report = async (m, b) => {
        if (fail) throw new Error('market down');
        return base(m, b);
      };
      const s = mk(sql);
      await drive(s, DIRECT(), 2);
      expect(inflight(sql)).toBe(0);
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM outbox')).toEqual([{ n: 1 }]);
      expect(r.alerts.map((a) => a.code)).toContain('report_failed');
      fail = false;
      await s.run();
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM outbox')).toEqual([{ n: 0 }]);
      expect(r.outcomes).toHaveLength(1);
      await s.run();
      expect(r.outcomes).toHaveLength(1);
    });
  });

  it('a proposal that was accepted but not yet processed survives a restart', async () => {
    await withSettler(async (sql, r, mk) => {
      expect(await mk(sql).submit(DIRECT())).toEqual({ accepted: true });
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM pending')).toEqual([{ n: 1 }]);
      await mk(sql).run();
      expect(r.w.sent).toHaveLength(1);
    });
  });

  it('the outcome the settler writes is what the market object takes: fills applied, marks released', async () => {
    const out = await withSettler(async (sql, r, mk) => {
      await drive(mk(sql), DIRECT());
      return r.outcomes[0].body;
    });
    const h = await fresh('1');
    const sell = vec('directMakerSell');
    const buy = vec('directTakerBuy');
    for (const v of [sell, buy]) {
      h.w.setCash(v.order.maker, 10n ** 12n);
      h.w.setPosition(1n, 0, v.order.maker, 10n ** 12n);
      await h.place(v);
    }
    await h.sql('UPDATE orders SET in_flight = 1');
    const res = await h.call('POST', '/outcome', { body: out });
    expect(res.status).toBe(200);
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 0 }]); // both filled in full
    void (env as Env);
  });
});

describe('what the settler tells a market it still holds (GET /held)', () => {
  it('names every order in the pending proposal, the transaction in flight, and every undelivered outcome; nothing once reported', async () => {
    const { heldHashes } = await import('../src/settler');
    await withSettler(async (sql, r, mk) => {
      const p = DIRECT();
      const all = [p.taker.hash, ...p.makers.map((m) => m.hash)].sort();
      r.w.onSend = () => ({ pending: true });
      const s = mk(sql);
      await s.submit(p);
      expect(heldHashes(sql).sort()).toEqual(all); // pending
      await s.run();
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM in_flight')[0]).toEqual({ n: 1 });
      expect(heldHashes(sql).sort()).toEqual(all); // in flight
      r.over.report = async () => {
        throw new Error('market unreachable');
      };
      r.w.receipts.set(r.w.sent[0].hash, { status: 1, effectiveGasPrice: r.w.baseFeePerGas + r.w.prio });
      await mk(sql).run(); // a settler reads its dependencies when built
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM outbox')[0]).toEqual({ n: 1 });
      expect(heldHashes(sql).sort()).toEqual(all); // reported to no one yet
      r.over.report = async () => undefined;
      await mk(sql).run();
      expect(heldHashes(sql)).toEqual([]);
    });
  });
});
