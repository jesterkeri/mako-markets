// The scheduler does not wait for its own receipt (adversary on 3f08d05: the polling made its subrequest count
// unbounded), and anvil acknowledges a transaction before it mines it. So a test that reads the chain after a run
// first waits here for every transaction that run reports.
import type { PublicClient } from 'viem';

import type { RunResult } from '../src/index';

export async function mined(client: Pick<PublicClient, 'waitForTransactionReceipt'>, ...results: (RunResult | null)[]) {
  for (const r of results) {
    if (!r || !r.ok) continue;
    for (const s of r.scheduled) if (s.tx) await client.waitForTransactionReceipt({ hash: s.tx, timeout: 10_000 });
  }
}
