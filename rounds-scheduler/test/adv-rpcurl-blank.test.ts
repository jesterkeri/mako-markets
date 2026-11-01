// Adversary on 13b47a9: an RPC_URL that is only whitespace must end the run with the fixed error, fetch nothing, and
// leave the lease free. Spec 2 says "only whitespace" without limiting it to what String.prototype.trim strips, so the
// cases below cover every Unicode White_Space code point (PropList.txt), including U+0085 NEXT LINE, which is
// White_Space=yes in Unicode but is not in ECMAScript's WhiteSpace or LineTerminator sets, so trim() keeps it.
import { afterEach, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

const env = {
  ROUNDS_ADDRESS: '0x00000000000000000000000000000000000A11CE',
  HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  INTERVAL_S: '7200',
  DRY_RUN: 'false',
  HOUSE_1_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  HOUSE_2_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

// Unicode 15 PropList.txt, White_Space: 0009..000D, 0020, 0085, 00A0, 1680, 2000..200A, 2028, 2029, 202F, 205F, 3000.
const WHITE_SPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

afterEach(() => vi.restoreAllMocks());

for (const cp of WHITE_SPACE) {
  const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  it(`RPC_URL of only ${label}: fixed error, nothing fetched, lease released`, async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
    const lease = memLease();
    const e = { ...env, RPC_URL: ` ${String.fromCodePoint(cp)} `, SCHEDULER_STATE: memNamespace(lease) } as Env;
    await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, e);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]).scheduler).toEqual({ ok: false, error: 'RPC_URL not set' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lease.held()).toBe(false);
  });
}
