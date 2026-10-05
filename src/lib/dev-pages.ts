// The one gate for /dev pages. MAKO_STAGE alone is not a production check: production runs with MAKO_STAGE=dev
// (DONE.md; /dev/aa-smoke answered 200 on makomarket.xyz on 2026-10-05). So a dev page also refuses whenever Vercel
// says this is the production deployment, and outside Vercel whenever Node runs a production build.

/// True where /dev pages may render: MAKO_STAGE=dev, and not a production deployment or production build.
export function devPagesAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (env.MAKO_STAGE !== 'dev') return false;
  if (env.VERCEL_ENV === 'production') return false;
  if (env.VERCEL_ENV === undefined && env.NODE_ENV === 'production') return false;
  return true;
}
