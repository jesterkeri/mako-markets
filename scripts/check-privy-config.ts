// ----------------------------------------------------------------------------
// scripts/check-privy-config.ts
//
// Release gate (INBOX_GAP_PLAN r18 [M5]): read a Privy app's settings with its app secret and check them against the
// reviewed configuration (src/lib/privy-config-check.ts), including the pinned wallet mode EXPECTED_WALLET_MODE.
// Read-only. Prints names and verdicts only, never a secret.
//
// Run in your own terminal (the secret stays in your shell), once per app:
//   NEXT_PUBLIC_PRIVY_APP_ID=<app id> PRIVY_APP_SECRET=<from Bitwarden> \
//     corepack pnpm@10.32.1 exec tsx scripts/check-privy-config.ts production
// The role is `production` or `development`, and nothing else is accepted. Exit 0 only on a pass; paste the printed
// lines into the deploy ledger.
// ----------------------------------------------------------------------------

import { PrivyClient } from '@privy-io/node';

import { EXPECTED_WALLET_MODE, runPrivyConfigCheck } from '../src/lib/privy-config-check';

runPrivyConfigCheck(
  process.argv.slice(2),
  process.env,
  (appId, appSecret) => new PrivyClient({ appId, appSecret }).apps().getSettings(),
  EXPECTED_WALLET_MODE,
)
  .then(({ exitCode, lines }) => {
    for (const l of lines) console.log(l);
    process.exit(exitCode);
  })
  .catch((err: unknown) => {
    // The error's name only: a message could echo a request.
    console.error('check-privy-config failed:', err instanceof Error ? err.name : 'unknown');
    process.exit(2);
  });
