import { and, eq, ne, or, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';

/// Whether an account other than `userId` holds or shows the name with this key: the keyed holder, or any account that
/// shows the name (one that shared it before migration 0017 and has no key keeps showing it until it renames, so
/// nobody else may take it meanwhile). The unique index on the key settles two new claims racing each other.
export async function nameHeldByOther(key: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        ne(users.id, userId),
        // The shown name is compared whatever the key says: an app version from before migration 0017 (still serving
        // right after the migration, or after a rollback) renames without updating the key.
        or(eq(users.displayNameKey, key), sql`lower(regexp_replace(btrim(${users.displayName}, ' '), ' +', ' ', 'g')) = ${key}`),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
