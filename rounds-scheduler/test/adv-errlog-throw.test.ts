// Adversary on 73849b1: the scheduled handler must log exactly one line and never throw, whatever value a run throws.
// The value is thrown from the lease (the Durable Object call), the first thing a run awaits.
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import type { SchedulerState } from '../src/state';

afterEach(() => vi.restoreAllMocks());

const envThrowing = (thrown: () => unknown) =>
  ({
    RPC_URL: 'https://monad-testnet.example/v2/SECRETKEY123/',
    ROUNDS_ADDRESS: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
    HOUSE_1_ADDRESS: '0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550',
    HOUSE_2_ADDRESS: '0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801',
    INTERVAL_S: '7200',
    DRY_RUN: 'true',
    HOUSE_1_PRIVATE_KEY: '',
    HOUSE_2_PRIVATE_KEY: '',
    SCHEDULER_STATE: {
      idFromName: () => ({}),
      get: () => ({
        acquire: async () => {
          throw thrown();
        },
      }),
    } as unknown as DurableObjectNamespace<SchedulerState>,
  }) as unknown as Env;

const cases: [string, () => unknown][] = [
  ['an object whose shortMessage getter throws', () => ({ name: 'Odd', get shortMessage() { throw new Error('getter boom'); } })],
  ['an object whose name getter throws', () => ({ get name() { throw new Error('getter boom'); } })],
  ['an object with a Symbol shortMessage', () => ({ name: 'Odd', shortMessage: Symbol('s') })],
  ['an object with a BigInt name', () => ({ name: 1n })],
  ['a revoked Proxy', () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; }],
];

for (const [label, thrown] of cases) {
  it(`logs one line and does not throw for ${label}`, async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, envThrowing(thrown)),
    ).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]).scheduler.ok).toBe(false);
  });
}
