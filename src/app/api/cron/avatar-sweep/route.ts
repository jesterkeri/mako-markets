import { sweepAvatars } from '@/lib/avatar-sweep';
import { checkCronAuth } from '@/lib/cron-auth';

// ----------------------------------------------------------------------------
// GET /api/cron/avatar-sweep (every 15 minutes, fired by mako-auto-resolver CF Worker on the aa-fast tick — see
// cf-worker/src/index.ts, minute % 15 gate)
//
// Deletes removed and replaced profile photos (Joshua 2026-10-19, owner decision Q-D, Codex PUBLIC_PROFILE R4 F1): the
// "check these files" set past its 5-minute grace, batch by batch within a 40 s budget, each file deleted unless an
// account points at it. See src/lib/avatar-sweep.ts. Any failure leaves the set as it was for the next run.
//
// Auth: Bearer-only. See cron-auth.ts.
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!checkCronAuth(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 403 });
  }
  try {
    const result = await sweepAvatars();
    // A backlog or failed deletes break the ~20-minute deletion bound: loud, so it is seen (Codex PUBLIC_PROFILE R5 F1).
    if (!result.complete) console.error('[cron/avatar-sweep] run left files due', result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/avatar-sweep] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'avatar-sweep-failed' }, { status: 500 });
  }
}
