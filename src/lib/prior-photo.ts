import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';

/// The account's row, locked, as the photo it holds right now: used as `UPDATE users ... FROM priorPhoto(id)` so the
/// write and the read of the photo it replaces are one statement. A removal and an upload landing together then each
/// get, and delete, exactly the file they replaced, never an orphan (adversary r5 on 7ead089).
export const priorPhoto = (userId: string) =>
  db.select({ id: users.id, url: users.avatarUrl }).from(users).where(eq(users.id, userId)).for('update').as('prior');
