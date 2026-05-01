import 'server-only';

import { timingSafeEqual } from 'node:crypto';

// ----------------------------------------------------------------------------
// src/lib/cron-auth.ts
//
// Bearer-token gate for Vercel Cron handlers. The required header is
// `Authorization: Bearer ${CRON_SECRET}`. Anything else returns false.
//
// `x-vercel-cron` and `user-agent: vercel-cron/1.0` are spoofable from
// any client — the header is set by Vercel's edge but there is no
// authenticated boundary preventing a third party from setting the same
// string. They are USEFUL for diagnostics (proves the invocation came
// from Vercel's scheduler vs an operator manually firing the endpoint
// with a curl + bearer), but they MUST NOT be used as authentication
// signals. The plan v6 verification §"Cron tests" matrix locks this in:
// `x-vercel-cron` alone → 403; valid Bearer alone → 200.
// ----------------------------------------------------------------------------

export function checkCronAuth(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    // Fail closed if the secret isn't configured. The cron is hot path;
    // a misconfigured secret is a deploy bug, not a transient condition.
    console.error(
      '[cron-auth] CRON_SECRET missing or too short. Set it in Vercel env.',
    );
    return false;
  }

  const auth = req.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return false;

  const presented = auth.slice('Bearer '.length).trim();
  if (presented.length === 0) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/// Read-only diagnostic context for cron logs. NEVER used as an auth
/// signal — auth is `checkCronAuth` only.
export function cronDiagnostics(req: Request): {
  vercelCronHeader: string | null;
  userAgent: string | null;
} {
  return {
    vercelCronHeader: req.headers.get('x-vercel-cron'),
    userAgent: req.headers.get('user-agent'),
  };
}
