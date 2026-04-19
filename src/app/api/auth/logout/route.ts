import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/admin-session';

export async function POST() {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return Response.json({ ok: true });
}
