// RPC_URL is a secret; unset or blank must stop the run with a fixed error, never fall back to viem's chain default
// (the public RPC) and never fetch anything.
import { afterEach, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index';
import wranglerToml from '../wrangler.toml?raw';
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

afterEach(() => vi.restoreAllMocks());

for (const [label, rpc] of [['unset', undefined], ['empty', ''], ['blank', ' \n ']] as const) {
  it(`RPC_URL ${label}: one fixed error, nothing fetched`, async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
    const e = { ...env, ...(rpc === undefined ? {} : { RPC_URL: rpc }), SCHEDULER_STATE: memNamespace(memLease()) } as Env;
    await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, e);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]).scheduler).toEqual({ ok: false, error: 'RPC_URL not set' });
  });
}

it('wrangler.toml does not set RPC_URL (it is a secret, and a var of the same name would clash)', () => {
  expect(wranglerToml).not.toMatch(/^\s*RPC_URL\s*=/m);
});
