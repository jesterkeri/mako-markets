# Migrations — hand-written, no `db:generate`

The migrations under this directory are **hand-written**, not produced
by `drizzle-kit generate`. The `meta/_journal.json` manifest is the
source of truth for `pnpm db:migrate`; intermediate snapshot files
(`meta/0002_snapshot.json`, `meta/0003_snapshot.json`,
`meta/0004_snapshot.json`) are deliberately absent.

## Workflow

To add a new migration:

1. Edit `src/db/schema.ts` to declare the new column / table.
2. Hand-write the SQL in `src/db/migrations/<NNNN>_<tag>.sql`.
   Number it sequentially (next index after the highest existing
   migration). Use the same naming pattern as siblings.
3. Append a new entry to `src/db/migrations/meta/_journal.json` with
   the matching `idx` and `tag`. `when` is a millisecond timestamp;
   any monotonically-increasing value works.
4. Run `pnpm db:migrate` to apply against the local DB.
5. Verify with `psql` or `pnpm verify:aa-tables` (or write an
   equivalent verifier for the new shape).

## Why no `pnpm db:generate`

`drizzle-kit generate` works by diffing `schema.ts` against the
**latest** snapshot under `meta/`. Because we have no snapshots
beyond `0001_snapshot.json`, running `db:generate` would diff the
current schema against the early-Phase-1A state and produce a
duplicate migration covering everything added in 0002–0004 plus any
new change. That would corrupt the migration history.

The `pnpm db:generate` script is gated behind a guard
(`scripts/db-generate-guard.mts`) and exits non-zero unless
`MAKO_ALLOW_DB_GENERATE=1` is set in the environment. Without the
override the guard prints this README's path and exits. With the
override it forwards to `drizzle-kit generate` unchanged.

This is intentional. Hand-written migrations match the policy used
for the AA tables (0002), the email-change cooldown column (0003),
and the TOTP / display-name / avatar columns (0004). Each was a
small, targeted change easier to author by hand than to wrangle
through drizzle-kit's diff output.

If you genuinely need `db:generate` (e.g., to rebuild snapshot
lineage from scratch by replaying historical migrations against an
empty schema and capturing the resulting snapshots one-by-one), set
the override:

POSIX (bash, zsh, sh):

```sh
MAKO_ALLOW_DB_GENERATE=1 pnpm db:generate
```

PowerShell (Windows):

```powershell
$env:MAKO_ALLOW_DB_GENERATE='1'; pnpm db:generate
```

Then commit the resulting `meta/<NNNN>_snapshot.json` files. That
has not been worth the effort yet.

## Reviewer checklist

When reviewing a migration PR:

- [ ] New `<NNNN>_<tag>.sql` is idempotent or guarded (`IF NOT
  EXISTS` for additive changes; explicit `DROP` only when
  intentional).
- [ ] `_journal.json` has a new entry with the matching `idx` and
  `tag`. Reordering existing entries breaks already-applied
  databases.
- [ ] `schema.ts` matches what the SQL produces.
- [ ] No new `meta/<NNNN>_snapshot.json` file (we don't ship them).
