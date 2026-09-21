#!/usr/bin/env node
// Draft a weekly DeltaV update from the last 7 days of git history.
// Reads ANTHROPIC_API_KEY from env. Prints the draft to stdout.
//
// Run locally:
//   ANTHROPIC_API_KEY=sk-... node scripts/deltav-draft-weekly.mjs
//
// In CI: see .github/workflows/deltav-weekly-draft.yml.

import { execSync } from 'node:child_process';
import process from 'node:process';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

const MODEL = 'claude-sonnet-4-6';
const SINCE = process.env.GIT_SINCE || '7 days ago';
const WEEK_NUMBER = process.env.WEEK_NUMBER || 'XX';

function gitLog() {
  try {
    return execSync(
      `git log --since="${SINCE}" --no-merges --pretty=format:"%h | %ad | %s%n%b%n----" --date=short`,
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ).trim();
  } catch (err) {
    console.error('git log failed:', err.message);
    process.exit(1);
  }
}

const SYSTEM_PROMPT = `You are drafting a weekly progress update for Mako Market, written in Joshua's founder voice for Monad's DeltaV builder platform.

CONTEXT (always true, do not invent contradictions):
- Mako Market is a pari-mutuel YES/NO prediction market on Monad testnet, denominated in USDC after the v4 contract migration.
- Market types live on-chain: FOOTBALL, CRYPTO, NBA, FOREX, COMMODITIES, STOCKS, MAKO. Price-feed types (CRYPTO/FOREX/COMMODITIES/STOCKS) settle off Pyth.
- Private Markets is in flight: Friendly, Open Vote, Prize Pool shapes for group-chat-native bets among friends. Gated behind a flag until parity ships.
- Joshua is a solo dev. The update must read like he wrote it himself.

OUTPUT FORMAT (strict, follow exactly, in order):

Weekly Update - Mako Market Week #${WEEK_NUMBER}

1. TL;DR
Quick wins: <1-2 sentences on the headline shipped work>
Challenges: <1-2 sentences on what hurt this week>
What's next: <one sentence on the upcoming focus>

2. Highlights
- <shipped feature, deal, partnership, or milestone>
- <another, ideally with a metric>
- <another, shoutout-worthy moment if any>

3. Lowlights
- <missed goal, incident, regression, slipped scope>
- (more bullets only if the week had more than one painful moment)
Being transparent so we can fix fast.

4. Core Metrics
- <metric 1>: <value or X to Y>
- <metric 2>: <value or X to Y>
- <metric 3>: <value or X to Y>

5. This Week's Focus
-> <top priority for the upcoming week>
-> <second priority if any>

6. Asks
- <specific, targeted ask 1>
- <intro request or feedback ask 2>
- <third ask if relevant>

7. Shoutouts
<teammates, advisors, users, infra providers who helped this week>

VOICE RULES (strict):
- Founder voice, conversational, founder-to-founder. Like talking to another builder in the same accelerator.
- NO em-dashes. Use commas, periods, colons, semicolons. Hyphens in compound words are fine. Use "->" for the Focus arrows, NOT "→" the unicode arrow either is fine but never an em-dash.
- NO mention of AI agents, Claude, Codex, Gemini, "peer review," "multi-agent setup." Joshua talks like he built it alone. (Tools used internally are fine to attribute to "the team" or just omit.)
- NO internal phase numbers (1A, 2B-2, 2C-2, etc.) or codenames. Translate to plain English: "the gas sponsorship work," "the bet flow," "the chart system."
- Surface-level technical depth. Say what changed and why a user or founder would care. Skip ABIs, schema fields, selector pins.
- Honest about self-inflicted friction in Lowlights. If the week had a painful incident (bad ship, broken cron, missing migration, prod regression), name it.
- NO emojis anywhere, including the title. Joshua's standing rule (2026-06-13) overrides any template that prescribes them.
- Asks must be SPECIFIC. Bad: "know anyone hiring?" Good: "looking for traders to stress-test forex markets on Monad testnet." Make them easy to act on.
- If a section is genuinely empty this week (no asks, no lowlights, no shoutouts), keep the heading and write "Nothing this week." underneath. Never reorder or drop sections.

LENGTH: aim for 300-500 words total across all 7 sections. Each section tight.

OUTPUT: Just the update text exactly in the structure above, ready to post. No preface, no signoff, no markdown code fences. Start with the "Weekly Update - Mako Market Week #${WEEK_NUMBER}" header line.`;

function buildUserMessage(log) {
  return `Here is the git log from the last 7 days for the mako-markets repo. Synthesize a weekly update following the voice rules.

If the log is empty or only contains chore/lint/dependency bumps, say honestly that this was a quiet week (e.g., "this week was light on shipping, mostly cleanup and planning") rather than inventing significance. Don't pad.

Git log:
\`\`\`
${log || '(no commits in window)'}
\`\`\``;
}

async function callClaude(userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Claude API error ${res.status}: ${body}`);
    process.exit(1);
  }

  const json = await res.json();
  const text = json.content?.[0]?.text;
  if (!text) {
    console.error('Claude API returned no text:', JSON.stringify(json).slice(0, 500));
    process.exit(1);
  }
  return text.trim();
}

const log = gitLog();
const draft = await callClaude(buildUserMessage(log));
process.stdout.write(draft + '\n');
