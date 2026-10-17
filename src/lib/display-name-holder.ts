import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';

/// Whether an account other than `userId` holds or shows the name with this key: the keyed holder, or an account that
/// shared the name before migration 0017 and still shows it without a key (it keeps showing it until it renames, so
/// nobody else may take it meanwhile). The unique index on the key settles two new claims racing each other.
export async function nameHeldByOther(key: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        ne(users.id, userId),
        or(eq(users.displayNameKey, key), and(isNull(users.displayNameKey), sql`lower(regexp_replace(btrim(${users.displayName}, ' '), ' +', ' ', 'g')) = ${key}`)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
