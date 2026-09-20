import { describe, expect, it } from 'vitest';
import { byteLength, CHECK_CODES, manifestLine, packCriticals, packNonCritical, pingHealthchecks, refundCommand, sendTelegram } from '../src/alerts';
import { makeNet } from '../src/net';
import { formatRanges } from '../src/discovery';
import { HC, makeFetch, makeWorld, MAKO, type World } from './fake';

function netFor(w: World, deadlineMs = 200_000) {
  return makeNet(makeFetch(w), () => w.clock.t, async (ms) => { w.clock.t += ms; }, w.clock.t + deadlineMs, 22);
}

describe('manifest', () => {
  it('compact ranges and sorted codes', () => {
    expect(formatRanges([81, 7, 80, 9, 78])).toBe('7,9,78,80-81');
    expect(manifestLine([7, 9, 78, 80, 81], ['rr', 'pb', 'uo'])).toBe('manifest ids: 7,9,78,80-81 | checks: pb,rr,uo');
    expect(manifestLine([], [])).toBe('manifest ids: - | checks: -');
    expect(() => manifestLine([], ['zz'])).toThrow();
  });
  it('2,000 four-digit ids (worst case: no two adjacent) plus every code fit three Telegram messages', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => 1000 + i * 2).filter((id) => id < 10_000);
    const worst = [...ids, ...Array.from({ length: 2000 - ids.length }, (_, i) => 10 + i * 2)].slice(0, 2000);
    const manifest = manifestLine(worst, [...CHECK_CODES]);
    expect(byteLength(manifest)).toBeLessThanOrEqual(10_100);
    const due = worst.map((id) => ({ key: `m:${id}`, line: `#${id} CRYPTO one-sided, unresolved 52h after close (YES 1.00 / NO 0.00): refund command below`.padEnd(300, '.') }));
    const pack = packCriticals('MAKO WATCHDOG: header', due, refundCommand(MAKO, [1, 2, 3]), manifest, undefined, undefined, worst.length);
    expect(pack.manifestTruncated).toBe(false);
    expect(pack.messages.length).toBeLessThanOrEqual(3);
    for (const m of pack.messages) expect(m.length).toBeLessThanOrEqual(4096);
    const joined = pack.messages.join('\n').replace(/\n/g, '');
    expect(joined).toContain(manifest.replace(/\n/g, ''));
  });
  it('five-digit ids beyond the envelope can overflow: the manifest is replaced and flagged', () => {
    const ids = Array.from({ length: 3000 }, (_, i) => 10_000 + i * 2);
    const pack = packCriticals('h', [], null, manifestLine(ids, ['se']), undefined, undefined, ids.length);
    expect(pack.manifestTruncated).toBe(true);
    expect(pack.messages.join('\n')).toContain('manifest truncated: 3000 ids');
  });
  it('detail lines that do not fit are counted, and only placed lines are reported', () => {
    const due = Array.from({ length: 100 }, (_, i) => ({ key: `m:${i}`, line: 'x'.repeat(400) }));
    const pack = packCriticals('h', due, null, manifestLine([1], []));
    expect(pack.placed.length).toBeLessThan(100);
    expect(pack.messages.join('\n')).toContain(`+${100 - pack.placed.length} more critical`);
    for (const p of pack.placed) expect(p.message).toBeLessThan(pack.messages.length);
  });
});

describe('message 4', () => {
  it('stops at the first line that does not fit, so delivered lines are a prefix', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ key: `n:${i}`, line: `NEW #${i} ` + 'y'.repeat(200) }));
    const r = packNonCritical('hdr', lines);
    expect(r.message!.length).toBeLessThanOrEqual(4096);
    expect(r.placedKeys).toEqual(lines.slice(0, r.placedKeys.length).map((l) => l.key));
    expect(r.message).toContain(`+${30 - r.placedKeys.length} more next run`);
  });
});

describe('refund command', () => {
  it('is runnable, one-sided only by contract, and uses the gas-only keystore', () => {
    const c = refundCommand(MAKO, [81, 78, 80]);
    expect(c).toContain(`for id in 78 80 81; do cast send ${MAKO} "forceRefund(uint256)" $id --rpc-url https://testnet-rpc.monad.xyz/ --account mako-refunder; done`);
    expect(c).not.toContain('—');
  });
});

describe('Telegram', () => {
  it('confirms on 200 with ok: true', async () => {
    const w = makeWorld();
    const r = await sendTelegram(netFor(w), { token: 't', chatId: '1', dryRun: false, log: () => {} }, ['a', 'b']);
    expect(r).toEqual([true, true]);
    expect(w.telegram.sent).toEqual(['a', 'b']);
  });
  it('429 whose retry_after ends before the deadline is retried once', async () => {
    const w = makeWorld({ telegram: { mode: '429', retryAfter: 3, sent: [], fail429Once: true } });
    const r = await sendTelegram(netFor(w), { token: 't', chatId: '1', dryRun: false, log: () => {} }, ['a']);
    expect(r).toEqual([true]);
  });
  it('429 beyond the deadline counts as undelivered, with no wait', async () => {
    const w = makeWorld({ telegram: { mode: '429', retryAfter: 500, sent: [], fail429Once: true } });
    const t0 = w.clock.t;
    const r = await sendTelegram(netFor(w), { token: 't', chatId: '1', dryRun: false, log: () => {} }, ['a']);
    expect(r).toEqual([false]);
    expect(w.clock.t - t0).toBeLessThan(1000);
  });
  it('never makes more than 4 requests', async () => {
    const w = makeWorld({ telegram: { mode: '429', retryAfter: 1, sent: [] } });
    await sendTelegram(netFor(w), { token: 't', chatId: '1', dryRun: false, log: () => {} }, ['a', 'b', 'c', 'd']);
    expect(w.log.filter((l) => l.startsWith('api.telegram.org')).length).toBe(4);
  });
});

describe('Healthchecks "accepted"', () => {
  const cases: [World['hc']['mode'], boolean][] = [
    ['ok', true],
    ['not_found', false],
    ['rate_limited', false],
    ['no_header', false],
    ['small_header', false],
    ['500', false],
    ['timeout', false],
  ];
  it.each(cases)('%s -> accepted %s', async (mode, accepted) => {
    const w = makeWorld({ hc: { mode, pings: [] } });
    const r = await pingHealthchecks(netFor(w), HC, 'success', 'body text', false, () => {});
    expect(r.accepted).toBe(accepted);
  });
  it('rejects a non-HTTPS check URL without sending', async () => {
    const w = makeWorld();
    const r = await pingHealthchecks(netFor(w), 'http://hc-ping.test/x', 'success', 'b', false, () => {});
    expect(r.accepted).toBe(false);
    expect(w.hc.pings).toHaveLength(0);
  });
  it('uses /fail and /log paths', async () => {
    const w = makeWorld();
    await pingHealthchecks(netFor(w), HC, 'fail', 'b', false, () => {});
    await pingHealthchecks(netFor(w), HC, 'log', 'b', false, () => {});
    expect(w.hc.pings.map((p) => p.url)).toEqual([`${HC}/fail`, `${HC}/log`]);
  });
});

// Review r6: commandMessages must name exactly the messages that hold command
// bytes. Claiming an extra message makes a delivered command look undelivered.
describe('commandMessages is exact', () => {
  const manifest = manifestLine([1, 2, 3], []);
  const command = refundCommand(MAKO, [7, 9, 78]);

  function assertExact(pack: ReturnType<typeof packCriticals>) {
    const holds = pack.messages.map((m) => m.includes('cast send'));
    const named = new Set(pack.commandMessages);
    holds.forEach((hasBytes, i) => {
      expect(named.has(i)).toBe(hasBytes); // named exactly when it holds bytes
    });
    expect(pack.commandMessages.length).toBeGreaterThan(0);
  }

  it('however the detail lines fall, across many line counts and lengths', () => {
    for (const count of [0, 1, 5, 17, 40, 120]) {
      for (const len of [60, 130, 400, 1200]) {
        const due = Array.from({ length: count }, (_, i) => ({ key: `m:${i}`, line: `#${i} ` + 'x'.repeat(len) }));
        assertExact(packCriticals('MAKO WATCHDOG: header', due, command, manifest));
      }
    }
  });

  it('when the command is pushed whole into the next message', () => {
    // Fill message 1 so the short command cannot fit in it.
    const due = [{ key: 'm:1', line: 'y'.repeat(4_000) }];
    const pack = packCriticals('h', due, command, manifest);
    expect(pack.messages[0].includes('cast send')).toBe(false);
    expect(pack.commandMessages).not.toContain(0);
    assertExact(pack);
  });

  it('when the command line is long enough to span messages', () => {
    // A continuation piece carries ids but not the literal "cast send", so the
    // oracle here is "does this message hold any of the command's ids".
    const ids = Array.from({ length: 900 }, (_, i) => 100000 + i);
    const pack = packCriticals('h', [], refundCommand(MAKO, ids), manifest);
    expect(pack.commandMessages.length).toBeGreaterThan(1);
    const named = new Set(pack.commandMessages);
    pack.messages.forEach((m, i) => {
      const holds = ids.some((id) => m.includes(String(id)));
      expect(named.has(i)).toBe(holds);
    });
  });
});
