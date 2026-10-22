# mako-beta-sweep

Fires `https://beta.makomarket.xyz/api/cron/avatar-sweep` every 15 minutes, so a removed or replaced profile photo on
beta is deleted the same way production's are (owner decisions Q-J and Q-L, 2026-10-19). Production's sweep is fired by
the main worker (`cf-worker/`); this one exists only because beta sits behind Vercel deployment protection.

## The secret it holds, and why it is treated as high-impact

`VERCEL_PROTECTION_BYPASS` is a Vercel "Protection Bypass for Automation" token. If it leaks it opens **every**
protected deployment of the mako-markets project (beta and all previews), not just this path. So:

- it is made for this worker only and used by nothing else, and it must **not** be the secret Vercel exposes to
  deployments (below);
- it is sent only in the `x-vercel-protection-bypass` header, never in a URL, only to the hard-coded beta host and path,
  and a redirect is never followed (`src/sweep.ts`, tested in `test/sweep.test.ts`);
- the worker never logs headers or URLs, only statuses and counts;
- it is rotated whenever this worker changes owner or code materially, and revoked when the worker is retired.

`BETA_CRON_SECRET` is beta's own `CRON_SECRET` (Vercel, Preview, branch `staging`).

**What Vercel does with these secrets** (docs, read 2026-10-19:
vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation):
"Vercel automatically sets one secret as the `VERCEL_AUTOMATION_BYPASS_SECRET` system environment variable in your
deployments. When you have multiple secrets, you can choose which one to use as the environment variable." And "you
can use each available secret to bypass Deployment Protection on all deployments in a project until the secret is
revoked." So as soon as any bypass secret exists, **a working one is inside every deployment's environment** (Codex
PUBLIC_PROFILE R6 F2). That cannot be switched off; what can be controlled is that it is **not this worker's**:

- two secrets: one named `deployments-env` that Vercel exposes to deployments, and one named `mako-beta-sweep` that
  only this worker holds;
- the worker's can then be rotated or revoked without touching deployments, and a leak from either side is traced
  to one secret.

The remaining exposure, the `deployments-env` secret readable by server code in any deployment, is the same place that
already holds `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN` and `CRON_SECRET`: anything able to read it can already do far
worse than open a preview. Isolating beta in its own Vercel project would shrink even that; it is not done here.

## Set up (owner, once this branch is on staging)

1. Vercel → mako-markets → Settings → Deployment Protection → Protection Bypass for Automation:
   a. add a secret named `deployments-env` and select it as the one exposed as `VERCEL_AUTOMATION_BYPASS_SECRET`;
   b. add a second secret named `mako-beta-sweep`; this is the worker's;
   c. check on that page that the exposed one is still `deployments-env`, not `mako-beta-sweep`. If they are ever the
      same, revoke `mako-beta-sweep` and start again.
   Do not reuse a secret made for anything else.
2. `cd beta-sweep && corepack pnpm@10.32.1 install --ignore-workspace` (outside the repo workspace: never install from
   the repo root for this folder).
3. `corepack pnpm@10.32.1 exec wrangler secret put VERCEL_PROTECTION_BYPASS` and paste the `mako-beta-sweep` token at
   the hidden prompt.
4. `corepack pnpm@10.32.1 exec wrangler secret put BETA_CRON_SECRET` and paste beta's CRON_SECRET from Vercel.
5. `corepack pnpm@10.32.1 exec wrangler deploy`.
6. `corepack pnpm@10.32.1 exec wrangler tail --format pretty` until a quarter-hour passes: expect `[beta-sweep] ok`.
   `[beta-sweep] failed http 302` or `401` means the bypass token is wrong; `403` means BETA_CRON_SECRET is wrong.

## Rotate or retire

Rotate: create a new secret in Vercel (not exposed to deployments), `wrangler secret put VERCEL_PROTECTION_BYPASS`
with it, check the tail, then delete the old one in Vercel. Retire: `wrangler delete`, then delete its secret in Vercel.
Vercel says regenerating or deleting the **exposed** secret invalidates it in existing deployments until they are
redeployed; the worker's secret is not the exposed one, so rotating it needs no redeploy.

## Checks

`corepack pnpm@10.32.1 exec tsc --noEmit`, `corepack pnpm@10.32.1 exec vitest run`,
`corepack pnpm@10.32.1 exec wrangler deploy --dry-run --outdir dist`.
