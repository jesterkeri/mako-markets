import { type Address } from 'viem';

import { db } from '@/db/client';
import { checkSameOrigin } from '@/lib/csrf';
import { browserFamily, composeFeedbackText, FEEDBACK_MAX_BODY_BYTES, parseFeedbackBody, type FeedbackMeta } from '@/lib/feedback';
import { feedbackLimitKey, reserveFeedback } from '@/lib/feedback-rate-limit';
import { refFromCookieHeader } from '@/lib/ref-tag';
import { deriveSafeAddress } from '@/lib/safe';
import { getUserSession, type UserSession } from '@/lib/user-session';

// ----------------------------------------------------------------------------
// POST /api/feedback
//
// Forwards a tester's message to Joshua's Telegram (GTM plan §1). Signed-out visitors may send too. Gate order:
//   same origin (403) -> the bot is configured (503 feedback_unavailable) -> strict body (400 / 413)
//   -> abuse limit (429; 503 when the limit cannot be checked) -> Telegram sendMessage (200, or 502).
//
// The message goes as PLAIN TEXT: no parse_mode, so nothing typed can become formatting or a link that looks like
// the site's own, and link previews are off. The server adds the page path, the account address when signed in, the
// ref tag and a short browser family; it never stores the message or an IP address. The bot token and the full
// Telegram URL are never logged or returned: errors log only a status code or an error's type.
// ----------------------------------------------------------------------------

export const dynamic = 'force-dynamic';

const TELEGRAM_TIMEOUT_MS = 8_000;

const json = (body: unknown, status: number) => Response.json(body, { status });

function telegramConfig(): { token: string; chatId: string } | null {
  // Trimmed: a value pasted into Vercel's env UI can keep a trailing newline.
  const token = process.env.FEEDBACK_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.FEEDBACK_TELEGRAM_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
}

async function sessionOrNull(): Promise<UserSession | null> {
  try {
    return await getUserSession();
  } catch (err) {
    // A broken session setup must not stop a report about a broken site; the sender counts as signed out.
    console.error('[feedback] session check failed:', err instanceof Error ? err.name : 'unknown');
    return null;
  }
}

function accountOf(session: UserSession | null): FeedbackMeta['account'] {
  if (!session) return null;
  if (session.authType === 'wallet') return { address: session.walletAddress, kind: 'wallet' };
  try {
    return { address: deriveSafeAddress(session.magicEoa as Address), kind: 'email' };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  if (!checkSameOrigin(req).ok) return json({ error: 'cross_origin' }, 403);

  const telegram = telegramConfig();
  if (!telegram) return json({ error: 'feedback_unavailable' }, 503);

  let text: string;
  try {
    text = await req.text();
  } catch {
    return json({ error: 'bad_body' }, 400);
  }
  if (new TextEncoder().encode(text).length > FEEDBACK_MAX_BODY_BYTES) return json({ error: 'too_large' }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ error: 'bad_body' }, 400);
  }
  const parsed = parseFeedbackBody(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const session = await sessionOrNull();

  let allowed: boolean;
  try {
    allowed = await reserveFeedback(db, feedbackLimitKey(session?.userId ?? null), new Date());
  } catch (err) {
    // Without the limit there is no send: an outage must not open an unlimited path to Telegram.
    console.error('[feedback] rate limit unavailable:', err instanceof Error ? err.name : 'unknown');
    return json({ error: 'limit_unavailable' }, 503);
  }
  if (!allowed) return json({ error: 'rate_limited' }, 429);

  const message = composeFeedbackText(parsed.body.message, {
    path: parsed.body.path,
    account: accountOf(session),
    ref: refFromCookieHeader(req.headers.get('cookie')),
    browser: browserFamily(req.headers.get('user-agent')),
  });

  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegram.chatId, text: message, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    // The error's type only: a network error's message can carry the request URL, which holds the token.
    console.error('[feedback] telegram unreachable:', err instanceof Error ? err.name : 'unknown');
    return json({ error: 'send_failed' }, 502);
  }
  let delivered = false;
  try {
    const body = (await res.json()) as { ok?: unknown };
    delivered = res.ok && body?.ok === true;
  } catch {
    delivered = false;
  }
  if (!delivered) {
    console.error('[feedback] telegram refused the message: http', res.status);
    return json({ error: 'send_failed' }, 502);
  }
  return json({ ok: true }, 200);
}
