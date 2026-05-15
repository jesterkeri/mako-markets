// ----------------------------------------------------------------------------
// scripts/_smoke-guard.mts
//
// Shared runtime safety guard for the PM smoke / maintenance / reset
// helpers. Codex r1 MAJ-1: every dev-only mutator (reset-sponsor-cap,
// seed-pm-indexer-cursor, run-pm-maintenance-once) must fail-closed if
// the env it loaded is not a dev env, and must print the resolved
// targets before doing anything so a misconfigured run is obvious.
//
// Contract:
//   requireDevStage(scriptName)
//     - exits non-zero unless MAKO_STAGE === 'dev', or the caller passed
//       `--allow-non-dev` on argv as an explicit one-shot override.
//     - the override path prints a loud warning so it can't be silent.
//
//   logResolvedTarget(scriptName, { dbUrl, contractAddress?, rpcUrl? })
//     - prints the actual DB / contract / RPC the script is about to
//       touch. DB password masked. Run BEFORE the destructive action.
// ----------------------------------------------------------------------------

const ALLOW_NON_DEV_FLAG = '--allow-non-dev';

export function requireDevStage(scriptName: string): void {
  const stage = process.env.MAKO_STAGE ?? '';
  const override = process.argv.includes(ALLOW_NON_DEV_FLAG);
  if (stage === 'dev') {
    if (override) {
      console.warn(
        `[${scriptName}] note: ${ALLOW_NON_DEV_FLAG} is redundant when MAKO_STAGE=dev`,
      );
    }
    return;
  }
  if (override) {
    console.warn(
      `[${scriptName}] WARNING: running with MAKO_STAGE='${stage || '(unset)'}' (override via ${ALLOW_NON_DEV_FLAG})`,
    );
    return;
  }
  console.error(
    `[${scriptName}] refused to run: MAKO_STAGE='${stage || '(unset)'}' (expected 'dev').`,
  );
  console.error(
    `[${scriptName}] if this is intentional (e.g. local CI), pass ${ALLOW_NON_DEV_FLAG}.`,
  );
  process.exit(1);
}

export function logResolvedTarget(
  scriptName: string,
  opts: { dbUrl: string; contractAddress?: string; rpcUrl?: string },
): void {
  const maskedDb = opts.dbUrl.replace(/:[^:@/]*@/, ':****@');
  console.log(`[${scriptName}] MAKO_STAGE  : ${process.env.MAKO_STAGE ?? '(unset)'}`);
  console.log(`[${scriptName}] DATABASE_URL: ${maskedDb}`);
  if (opts.contractAddress) {
    console.log(`[${scriptName}] CONTRACT    : ${opts.contractAddress}`);
  }
  if (opts.rpcUrl) {
    console.log(`[${scriptName}] RPC         : ${opts.rpcUrl}`);
  }
}
