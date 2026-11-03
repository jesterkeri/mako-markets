// One authenticated tick of /api/cron/notify (#214, NOTIFICATIONS_PLAN r8 §3.9). Beta has no schedule (every tick
// wakes the dev Neon) and sits behind Vercel SSO, so it is ticked by hand; production is ticked with this before the
// Worker starts pinging the route.
//
//   NOTIFY_TICK_URL=https://beta.makomarket.xyz NOTIFY_TICK_SECRET=… VERCEL_AUTOMATION_BYPASS_SECRET=… \
//     node scripts/notify-tick.mjs [--until-current]
//
// NOTIFY_TICK_SECRET is that environment's CRON_SECRET (beta's Preview secret is never production's). The bypass
// secret is only needed for beta. Secrets come from the environment (the Bitwarden pipe) and are never printed.
// --until-current repeats the tick 2 s apart until both scans report upToDate, at most 150 ticks. It stops at once on
// a non-200 answer, a scan error (including roster_changed: run it again) or noFloor (NOTIFY_FROM_BLOCK missing from
// the build). A scan reported busy (another call holds the lock) does not stop it. Running it again resumes.
import process from 'node:process';

const ALLOWED = new Set(['https://beta.makomarket.xyz', 'https://makomarket.xyz']);
const MAX_TICKS = 150;

const base = (process.env.NOTIFY_TICK_URL ?? '').trim().replace(/\/+$/, '');
const secret = (process.env.NOTIFY_TICK_SECRET ?? '').trim();
const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '').trim();
const loop = process.argv.includes('--until-current');
if (!ALLOWED.has(base)) {
  console.error(`NOTIFY_TICK_URL must be one of: ${[...ALLOWED].join(', ')}`);
  process.exit(2);
}
if (secret.length < 16) {
  console.error('NOTIFY_TICK_SECRET is missing or too short.');
  process.exit(2);
}

const headers = { authorization: `Bearer ${secret}`, ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) };
const line = (name, s) =>
  !s ? `${name}: none`
  : s.skipped ? `${name}: skipped (${s.skipped})`
  : s.error && !('mutex' in s) ? `${name}: ${s.error}`
  : `${name}: ${s.mutex}${s.error ? ` error=${s.error}` : ''} scannedTo=${s.scannedTo} scanTarget=${s.scanTarget} ` +
    `left=${s.scanTarget != null && s.scannedTo != null ? s.scanTarget - s.scannedTo : '?'} upToDate=${s.upToDate} ` +
    `notifiedThrough=${s.notifiedThrough} rosterFromChain=${s.rosterFromChain} noFloor=${s.noFloor}`;
const done = (s) => s && (s.upToDate === true || s.skipped === 'rounds_off');
const fatal = (s) => s && (s.noFloor === true || ('error' in s && s.error !== undefined));

for (let tick = 1; tick <= (loop ? MAX_TICKS : 1); tick += 1) {
  const res = await fetch(`${base}/api/cron/notify`, { headers, redirect: 'manual' });
  console.log(`tick ${tick}: HTTP ${res.status}`);
  if (res.status !== 200) process.exit(1);
  const body = await res.json();
  console.log(`  ${line('v4', body.v4)}\n  ${line('rounds', body.rounds)}\n  prune: ${JSON.stringify(body.prune)}  ${body.durationMs} ms`);
  if (fatal(body.v4) || fatal(body.rounds)) process.exit(1);
  if (!loop) process.exit(0);
  if (done(body.v4) && done(body.rounds)) {
    console.log('Both scans are up to date.');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
console.error(`Stopped at the ${MAX_TICKS}-tick cap; the "left" figures above are what remains. Run it again to resume.`);
process.exit(1);
