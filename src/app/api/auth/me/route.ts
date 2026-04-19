import { getAdminSession } from '@/lib/admin-session';

/**
 * Cheap probe for whether the current request carries a valid admin session
 * cookie. Used by admin pages that don't already hit /api/admin/analytics
 * (e.g. /admin/resolve) so they can render the SIWE login panel without
 * triggering a full RPC aggregation just to learn the session state.
 */
export async function GET() {
  const session = await getAdminSession();
  if (!session) return Response.json({ authed: false }, { status: 401 });
  return Response.json({ authed: true, address: session.address });
}
