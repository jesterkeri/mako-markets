// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-constants.test.ts
//
// aa-constants.ts is server-neutral — explicitly NOT `import 'server-only'`.
// This test enforces that boundary so a future edit can't quietly bring in
// a server-only import and break vitest / scripts / cron contexts.
//
// Coverage:
//   - SENDING_RECOVERY_THRESHOLD_MS resolves and is the documented 5 minutes.
//   - Receipt poll constants are sane.
//   - VALIDITY_WINDOW_MAX_UINT48 equals 2^48 - 1 as a bigint.
//   - aa-constants imports without throwing in a Node test environment
//     (proves it stays free of `server-only`, which is what would surface
//     here as an "ESM resolver error" or similar).
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import * as aaConstants from '../aa-constants';

describe('aa-constants', () => {
  it('SENDING_RECOVERY_THRESHOLD_MS is 300_000 (5 min)', () => {
    expect(aaConstants.SENDING_RECOVERY_THRESHOLD_MS).toBe(5 * 60_000);
  });

  it('RECEIPT_POLL_TIMEOUT_MS is 90_000', () => {
    expect(aaConstants.RECEIPT_POLL_TIMEOUT_MS).toBe(90_000);
  });

  it('RECEIPT_POLL_INTERVAL_MS is 1_000', () => {
    // Bumped from 3_000 to 1_000 on 2026-05-03 as the deferred quick
    // win from the 1D wrapper-hotfix follow-ups list. Faster Magic-
    // flow UX without a structural change. Phase 1I async architecture
    // remains the real fix.
    expect(aaConstants.RECEIPT_POLL_INTERVAL_MS).toBe(1_000);
  });

  it('SUBMITTED_RESOLVER_MAX_AGE_MS is 1_800_000 (30 min)', () => {
    expect(aaConstants.SUBMITTED_RESOLVER_MAX_AGE_MS).toBe(30 * 60_000);
  });

  it('VALIDITY_WINDOW_MAX_UINT48 equals 2^48 - 1 as a bigint', () => {
    expect(aaConstants.VALIDITY_WINDOW_MAX_UINT48).toBe(0xFFFFFFFFFFFFn);
    expect(typeof aaConstants.VALIDITY_WINDOW_MAX_UINT48).toBe('bigint');
  });

  it('module imports without server-only resolution errors', () => {
    // The act of importing at the top of this file is the test. If
    // aa-constants ever pulls in `server-only`, vitest will fail to load
    // the module before reaching here. This explicit check just makes
    // the intent legible to readers.
    expect(typeof aaConstants.SENDING_RECOVERY_THRESHOLD_MS).toBe('number');
  });
});
