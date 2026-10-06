// ----------------------------------------------------------------------------
// scripts/check-privy-config.ts
//
// Release gate (INBOX_GAP_PLAN r18 [M5]): read a Privy app's settings with its app secret and check them against the
// reviewed configuration (src/lib/privy-config-check.ts). Read-only. Prints names and verdicts only, never a secret.
//
// Run in your own terminal (the secret stays in your shell), once per app:
//   NEXT_PUBLIC_PRIVY_APP_ID=<app id> PRIVY_APP_SECRET=<from Bitwarden> \
//     corepack pnpm@10.32.1 exec tsx scripts/check-privy-config.ts production [expected wallet mode]
// The role is `production` or `development`. Exit 0 only on a pass; paste the printed lines into the deploy ledger.
// ----------------------------------------------------------------------------

import { PrivyClient } from '@privy-io/node';

import { checkPrivyAppConfig, type AppRole, type PrivyAppSettings } from '../src/lib/privy-config-check';

async function main() {
  const role = process.argv[2] as AppRole;
  const expectedMode = process.argv[3];
  if (role !== 'production' && role !== 'development') throw new Error('usage: check-privy-config.ts production|development [expected wallet mode]');
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error('NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET must be set in this shell');
  const settings = (await new PrivyClient({ appId, appSecret }).apps().getSettings()) as unknown as PrivyAppSettings;
  const v = checkPrivyAppConfig(settings, role, appId, expectedMode);
  console.log(`privy config check, ${role} app ${appId}, ${new Date().toISOString()}`);
  console.log(`recorded: ${JSON.stringify(v.recorded)}`);
  for (const f of v.failures) console.log(`FAIL ${f}`);
  console.log(v.ok ? 'PASS' : `FAIL (${v.failures.length})`);
  process.exit(v.ok ? 0 : 1);
}

main().catch((err: unknown) => {
  // The error's name only: a message could echo a request.
  console.error('check-privy-config failed:', err instanceof Error ? err.name : 'unknown');
  process.exit(2);
});
