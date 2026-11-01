// Adversary on 9bc8a37: the redirect fix inside workerd, not only Node. Needs test/adv-ccip2-workers.config.ts (its
// outboundService answers every fetch offline); under the default workers config it skips, so it never reaches a network.
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index';

const adv = (env as unknown as { ADV_CCIP2?: string }).ADV_CCIP2 === '1';
const counts = async (path = '/') => (await (await fetch(`http://count.test${path}`)).json()) as { gatewayHits: number; rpcHits: number };

it.skipIf(!adv)('control: workerd fetch follows a 307 by default, through the outbound service', async () => {
  await counts('/reset');
  await fetch('http://rpc.test/', { method: 'POST', body: '{}' });
  expect(await counts()).toEqual({ gatewayHits: 1, rpcHits: 1 });
});

it.skipIf(!adv)('an RPC 307 sends nothing to the other host and is logged with its status', async () => {
  await counts('/reset');
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
  const runEnv = {
    ...(env as unknown as Env),
    RPC_URL: 'http://rpc.test/',
    ROUNDS_ADDRESS: '0x00000000000000000000000000000000000A11CE',
    HOUSE_1_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    HOUSE_2_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    DRY_RUN: 'false',
    HOUSE_1_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    HOUSE_2_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  } as Env;
  await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} } as ScheduledController, runEnv);
  vi.restoreAllMocks();
  expect(logs).toHaveLength(1);
  expect(await counts()).toEqual({ gatewayHits: 0, rpcHits: 1 });
  expect(JSON.parse(logs[0]).scheduler.error).toMatch(/^HttpRequestError status 307 \| /);
});
