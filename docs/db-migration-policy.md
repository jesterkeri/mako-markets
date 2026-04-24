# Database migration policy

Short rules for changing `src/db/schema.ts`, written down once so we don't
re-learn them the hard way.

## Never edit an applied migration file

Drizzle stores a content hash of every migration in `__drizzle_migrations`.
If you change the SQL inside a file that's already been applied to a running
DB, the hash drifts and future `pnpm db:migrate` runs either fail the hash
check or get confused about whether the migration is applied.

If you notice something wrong with an applied migration, fix it with a new
follow-up migration — don't retro-edit.

## Prefer expand-and-contract for anything that could run with live traffic

A "rolling" deploy (Vercel Preview + Production pointing at the same Neon
DB) means two app versions briefly coexist. If one app version writes a
column and another doesn't know about it, you get 500s.

The safe pattern:

1. **Expand.** Add the new shape alongside the old one. Make new columns
   nullable or give them a default. If you're dropping a column, first stop
   writing to it in the app and make it nullable in the DB.
2. **Deploy the app** so every instance is on the new shape.
3. **Contract.** Once nobody writes or reads the old shape, drop it in a
   follow-up migration.

Migrations that skip the expand step will break auth / writes / reads for
any request that hits the "wrong" app version during rollout.

## What this means in practice

### Adding a column
- Either make it nullable, or give it a default value for existing rows.
  Don't add `NOT NULL` without a default unless the table is guaranteed empty.
- No app change needed in migration step 1.

### Removing a column
- Step 1 (expand): app stops writing to the column. Optionally, make the
  column nullable so old app versions can still insert without it.
- Step 2: deploy.
- Step 3 (contract): migration drops the column.

### Renaming a column
- Step 1 (expand): add new column. Backfill by writing to both columns.
- Step 2: deploy; readers prefer new column, fall back to old.
- Step 3 (contract): drop old column.

### Changing a column's type
- Usually requires two columns temporarily: `amount_old` + `amount_new`
  with dual writes, cut over reads, then drop the old one.

### Adding / removing an enum value
- Postgres enums aren't fully rollable — `ALTER TYPE ... ADD VALUE` is
  safe (can't be rolled back in a transaction, but safe for live reads).
  Removing a value from an enum requires creating a new enum type, casting
  columns over, dropping the old type. Prefer appending; reserve removal
  for explicit deprecation cycles.

### Adding a NOT NULL constraint / CHECK constraint
- Adding `NOT NULL` to a column with any NULL rows will fail. Run a
  backfill UPDATE first, then add the constraint with `NOT VALID` + a
  follow-up `VALIDATE CONSTRAINT` to avoid long lock windows.

### Adding / dropping a foreign key
- Adding an FK validates every existing row — can be slow. Use `NOT
  VALID` on the ADD, then `VALIDATE CONSTRAINT` in a follow-up to avoid
  blocking writes during validation.
- Dropping an FK is fast but removes referential integrity. Ensure no
  code relies on the ON DELETE / ON UPDATE behaviour of the FK before
  dropping.

### Adding / dropping an index
- Use `CREATE INDEX CONCURRENTLY` in Postgres so the index build doesn't
  take an exclusive lock on the table. Drizzle doesn't emit
  `CONCURRENTLY` by default — you may need to hand-edit the migration
  SQL for live tables.
- Dropping an index is fast but any query that relied on it will get
  slower; double-check query plans first.

### Renaming a table
- Table renames rewrite path roles. Prefer: add new table + view that
  aliases the old name, migrate writers, migrate readers, drop old view.
  For small teams and empty tables, a single `ALTER TABLE ... RENAME
  TO` during a coordinated cutover is pragmatic.

### Renaming or re-ordering an enum value
- Same story as column renames — rename in code and DB across a
  coordinated cutover, or introduce a new value alongside the old and
  migrate in a two-step.

## The 0001_long_penance.sql exception

This migration dropped `sessions.hmac_token` in one step, not the safe
expand-and-contract pattern. It was safe here because:

- The sessions table was empty (Phase 1 auth hadn't shipped yet)
- No other Vercel environment had a deployed Phase-1 app running against the
  same Neon DB (all environments share one DB; only v3 MON-denominated code
  was live, and v3 doesn't touch `sessions`)
- It was a coordinated cutover window for Phase 1 scaffolding

Once Phase 1 is live with real users, treat the sessions table as hot and
use expand-and-contract for every change.
