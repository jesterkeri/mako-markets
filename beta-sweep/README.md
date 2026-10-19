# mako-beta-sweep

Fires `https://beta.makomarket.xyz/api/cron/avatar-sweep` every 15 minutes, so a removed or replaced profile photo on
beta is deleted the same way production's are (owner decisions Q-J and Q-L, 2026-10-19). Production's sweep is fired by
the main worker (`cf-worker/`); this one exists only because beta sits behind Vercel deployment protection.

## The secret it holds, and why it is treated as high-impact

`VERCEL_PROTECTION_BYPASS` is a Vercel "Protection Bypass for Automation" token. If it leaks it opens **every**
protected deployment of the mako-markets project (beta and all previews), not just this path. So:

- it is made for this worker only and used by nothing else;
- it is sent only in the `x-vercel-protection-bypass` header, never in a URL, only to the hard-coded beta host and path,
  and a redirect is never followed (`src/sweep.ts`, tested in `test/sweep.test.ts`);
- the worker never logs headers or URLs, only statuses and counts;
- it is rotated whenever this worker changes owner or code materially, and revoked when the worker is retired.

`BETA_CRON_SECRET` is beta's own `CRON_SECRET` (Vercel, Preview, branch `staging`).

## Set up (owner, once this branch is on staging)

1. Vercel → mako-markets → Settings → Deployment Protection → Protection Bypass for Automation → add a new secret,
   named for this worker. Do not reuse one made for anything else.
2. `cd beta-sweep && corepack pnpm@10.32.1 install --ignore-workspace` (outside the repo workspace: never install from
   the repo root for this folder).
3. `corepack pnpm@10.32.1 exec wrangler secret put VERCEL_PROTECTION_BYPASS` and paste the token at the hidden prompt.
4. `corepack pnpm@10.32.1 exec wrangler secret put BETA_CRON_SECRET` and paste beta's CRON_SECRET from Vercel.
5. `corepack pnpm@10.32.1 exec wrangler deploy`.
6. `corepack pnpm@10.32.1 exec wrangler tail --format pretty` until a quarter-hour passes: expect `[beta-sweep] ok`.
   `[beta-sweep] failed http 302` or `401` means the bypass token is wrong; `403` means BETA_CRON_SECRET is wrong.

## Rotate or retire

Rotate: create a new bypass secret in Vercel, `wrangler secret put VERCEL_PROTECTION_BYPASS` with it, check the tail,
then delete the old one in Vercel. Retire: `wrangler delete`, then delete its bypass secret in Vercel.

## Checks

`corepack pnpm@10.32.1 exec tsc --noEmit`, `corepack pnpm@10.32.1 exec vitest run`,
`corepack pnpm@10.32.1 exec wrangler deploy --dry-run --outdir dist`.
