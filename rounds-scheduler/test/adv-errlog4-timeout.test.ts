// Adversary errlog4: a read that never answers must be logged as a timeout (spec rule 1), with no status or code taken
// from any other request. Offline: a fake fetch that only ends when viem aborts it.
import { expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { memLease, memNamespace } from './lease-fake';

it('a stalled first read is logged as TimeoutError with no status or code', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_u, init) =>
      new Promise((_ok, no) => {
        const s = (init as RequestInit).signal!;
        s.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError')));
      }),
  );
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, {
    RPC_URL: 'https://rpc.test/v2/SENTINELKEY',
    ROUNDS_ADDRESS: '0x00000000000000000000000000000000000A11CE',
    HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    INTERVAL_S: '7200',
    DRY_RUN: 'true',
    HOUSE_1_PRIVATE_KEY: '',
    HOUSE_2_PRIVATE_KEY: '',
    SCHEDULER_STATE: memNamespace(memLease()),
  } as unknown as Env);
  vi.restoreAllMocks();
  expect(logs).toHaveLength(1);
  const { scheduler } = JSON.parse(logs[0]);
  expect(scheduler.error).toMatch(/^TimeoutError \| /);
  expect(scheduler.error).not.toMatch(/status|code/);
}, 20_000);
