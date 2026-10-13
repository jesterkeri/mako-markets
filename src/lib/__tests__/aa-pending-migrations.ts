// The real hand-written migration SQL for aa_pending_user_ops columns added after 0002, for PGlite tests that create
// the 0002 table inline. Applying the committed file (not a copy) means a broken migration fails these tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '../../db/migrations');

export function aaPendingValidityWindowSql(): string {
  return readFileSync(join(MIGRATIONS, '0016_aa_pending_validity_window.sql'), 'utf8').replaceAll('--> statement-breakpoint', '');
}
