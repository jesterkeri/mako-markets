// Adversary on 90120da: the Worker as wrangler builds it must start in workerd and run its own scheduled().
// workerd treats every named export of the main module as an entrypoint and refuses to start when one is not a
// function, class or handler object. src/index.ts exports plain constants (MAX_SCAN_PAGES, READ_TIMEOUT_MS,
// SEND_TIMEOUT_MS, WORST_CASE_SUBREQUESTS, ROUNDS_ABI) for the Node tests, so `wrangler dev --test-scheduled` stops
// with "Incorrect type for map entry 'MAX_SCAN_PAGES'", and no cron run can ever happen. Every other test imports
// runScheduler in Node or the Durable Object alone, so none loads the Worker as a whole.
// No network: RPC_URL points at local port 9 (discard), which nothing listens on, so the run's reads fail at once and
// scheduled() reports the error and returns. The house keys are generated fresh here and DRY_RUN stays "true".
// Node-only APIs stay out: this file is typechecked with the Workers types (test/tsconfig.json), so paths are relative
// to the package root, where vitest runs.
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { unstable_dev } from 'wrangler';

describe('the Worker loads in workerd', () => {
  it('starts, and its scheduled() runs to completion', async () => {
    const rpc = 'http://127.0.0.1:9/';
    const starting = unstable_dev('src/index.ts', {
      config: 'wrangler.toml',
      ip: '127.0.0.1',
      port: 0,
      inspectorPort: 0,
      logLevel: 'error',
      vars: { RPC_URL: rpc, DRY_RUN: 'true', HOUSE_1_PRIVATE_KEY: generatePrivateKey(), HOUSE_2_PRIVATE_KEY: generatePrivateKey() },
      experimental: { testScheduled: true, disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
    // When workerd refuses the script, the dev server still answers "started" and the request never settles, so
    // the whole run is bounded here.
    const LIMIT_MS = 45_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<string>((r) => {
      timer = setTimeout(() => r(`no answer from scheduled() within ${LIMIT_MS / 1000} s`), LIMIT_MS);
    });
    const run = (async () => {
      const worker = await starting;
      const res = await worker.fetch('/__scheduled?cron=*/5+*+*+*+*');
      return `${res.status} ${await res.text()}`;
    })().catch((err: unknown) => String((err as Error)?.message ?? err));
    try {
      expect(await Promise.race([run, bounded])).toBe('200 Ran scheduled event');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await Promise.race([starting.then((w) => w.stop()), new Promise((r) => setTimeout(r, 5_000))]).catch(() => {});
    }
  }, 90_000);
});
