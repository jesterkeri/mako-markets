import { describe, expect, it } from 'vitest';
import toml from '../wrangler.toml?raw';
import { CONFIRM_IDS_PER_RUN, ENVELOPE_N, ID_BUDGET, LEASE_MS, MAX_COMMANDS_PER_RUN, RUN_DEADLINE_MS } from '../src/config';
import { BOOTSTRAP_PUBLIC_REQUESTS, MAX_HTTP_REQUESTS, MAX_HTTP_REQUESTS_BOOTSTRAP } from '../src/run';

// The deployed configuration and the numbers the code enforces must say the
// same thing (review r5: the documented cap drifted from the enforced one).
describe('wrangler.toml matches the enforced limits', () => {
  it('cron, CPU, subrequests, Durable Object binding and migration', () => {
    expect(toml).toContain('crons = ["*/5 * * * *"]');
    expect(toml).toContain('cpu_ms = 5000');
    expect(toml).toContain('subrequests = 100');
    expect(toml).toContain('name = "WATCHDOG_STATE"');
    expect(toml).toContain('new_sqlite_classes = ["WatchdogState"]');
    expect(toml).not.toContain('PRIVATE_KEY');
  });
  it('the documented request ceilings are the enforced ones, plus the two Durable Object calls', () => {
    const ordinary = MAX_HTTP_REQUESTS + 2;
    const bootstrap = MAX_HTTP_REQUESTS_BOOTSTRAP + 2;
    expect(ordinary).toBe(23);
    expect(bootstrap).toBe(32);
    expect(toml).toContain(`at most ${ordinary} requests`);
    expect(toml).toContain(`at most ${bootstrap}`);
    // The enumerated ordinary call graph: 11 provider B, 1 rr, 1 confirmation,
    // 3 probes, 4 Telegram, 1 Healthchecks.
    expect(11 + 1 + 1 + 3 + 4 + 1).toBe(MAX_HTTP_REQUESTS);
    // The bootstrap run swaps the single confirmation for up to 10 public reads.
    expect(MAX_HTTP_REQUESTS - 1 + BOOTSTRAP_PUBLIC_REQUESTS).toBe(MAX_HTTP_REQUESTS_BOOTSTRAP);
  });
  it('the scan and scheduling constants the plan fixes', () => {
    expect(ID_BUDGET).toBe(2000);
    expect(ENVELOPE_N).toBe(2000);
    expect(CONFIRM_IDS_PER_RUN).toBe(200);
    expect(MAX_COMMANDS_PER_RUN).toBe(50);
    expect(RUN_DEADLINE_MS).toBe(200_000);
    expect(LEASE_MS).toBe(270_000);
    expect(RUN_DEADLINE_MS).toBeLessThan(LEASE_MS);
  });
});
