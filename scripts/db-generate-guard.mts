// ----------------------------------------------------------------------------
// scripts/db-generate-guard.mts
//
// `pnpm db:generate` runs this. Migrations in this repo are hand-
// written (see src/db/migrations/README.md): drizzle-kit's diff
// against the latest snapshot under `meta/` would emit a duplicate
// migration covering everything in 0002–0004 plus any new change,
// which corrupts the migration history.
//
// To keep the script available for the rare case where someone
// genuinely wants to rebuild snapshot lineage from scratch, the
// command is gated behind an explicit env var:
//
//   MAKO_ALLOW_DB_GENERATE=1 pnpm db:generate
//
// Without the env var, this guard exits non-zero with a pointer to
// the README. The intent: an unaware contributor doesn't bork the
// migration history by autocompleting `pnpm db:generate`; an
// intentional contributor reads the README first, opts in, and
// understands what they're doing.
// ----------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const OVERRIDE = process.env.MAKO_ALLOW_DB_GENERATE;

if (OVERRIDE !== '1') {
  console.error(
    [
      '',
      'pnpm db:generate is intentionally gated.',
      '',
      'Migrations in this repo are hand-written. Running drizzle-kit',
      'generate against the current schema would emit a duplicate',
      'migration covering everything 0002–0004 already shipped, then',
      'corrupt the migration history.',
      '',
      'Read src/db/migrations/README.md for the workflow. To add a new',
      'migration: write the SQL by hand, append the journal entry,',
      'apply with `pnpm db:migrate`.',
      '',
      'If you genuinely need drizzle-kit generate (e.g., rebuilding',
      'snapshot lineage from scratch), set MAKO_ALLOW_DB_GENERATE=1:',
      '',
      '  # POSIX (bash, zsh, sh):',
      '  MAKO_ALLOW_DB_GENERATE=1 pnpm db:generate',
      '',
      '  # PowerShell (Windows):',
      "  $env:MAKO_ALLOW_DB_GENERATE='1'; pnpm db:generate",
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const result = spawnSync('drizzle-kit', ['generate'], {
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
