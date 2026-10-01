// Adversary pass on the feedback route (GTM plan section 1). The page path is the only header field a sender
// controls, so it must not carry characters that break a line or reorder text in Telegram: a C1 control such as
// NEL (U+0085, a mandatory line break under UAX #14) lets the path print a second "Account:" header line above the
// server's own, and bidi overrides make the Page line read in a different order than it is stored. The message
// body already strips exactly these (feedback.ts STRIP); the path does not. fetch is mocked: nothing reaches
// Telegram. Also: the limiter deletes a key's NEWER window when an older hour arrives, which resets the cap.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseFeedbackBody } from '@/lib/feedback';

import { createFeedbackTestDb, type FeedbackTestDb } from './feedback-test-db';

const TOKEN = '7654321:AAF-adversary-sentinel-token';
const CHAT = '-1009876543210';

const state = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: () => Promise.resolve(state.session) }));

const { POST } = await import('@/app/api/feedback/route');
const { reserveFeedback, feedbackLimitKey } = await import('@/lib/feedback-rate-limit');

const U1 = '11111111-1111-4111-8111-111111111111';
const VICTIM = '0xdEADbeEf00000000000000000000000000000001';

let tdb: FeedbackTestDb;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tdb = await createFeedbackTestDb();
  state.db = tdb.db;
  state.session = null;
  process.env.FEEDBACK_TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.FEEDBACK_TELEGRAM_CHAT_ID = CHAT;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FEEDBACK_TELEGRAM_BOT_TOKEN;
  delete process.env.FEEDBACK_TELEGRAM_CHAT_ID;
  await tdb.close();
});

function req(body: unknown) {
  return new Request('http://localhost/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0' },
    body: JSON.stringify(body),
  });
}

// Mandatory line breaks per UAX #14 (classes BK, CR, LF, NL): what a renderer starts a new line on.
const LINE_BREAKS = new RegExp('\\r\\n|[\\n\\r\\u000b\\u000c\\u0085\\u2028\\u2029]');
// C0/C1 controls and the bidi marks, embeddings, overrides and isolates the message cleaner removes.
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]');

describe('the page path cannot forge header fields', () => {
  it('parseFeedbackBody never accepts a path holding a control or bidi character ("no spaces or control characters")', () => {
    for (const c of ['\u0085', '\u0080', '\u009b', '‮', '⁦', '‏']) {
      const r = parseFeedbackBody({ message: 'hi', path: `/pools${c}12` });
      const kept = r.ok ? UNSAFE.test(r.body.path) : false; // refused, or accepted with the character removed
      expect(kept, `U+${c.codePointAt(0)!.toString(16)} kept in ${JSON.stringify(r)}`).toBe(false);
    }
  });

  it('a signed-out sender cannot put a second Account line in the header Telegram shows', async () => {
    const path = `/pools/12\u0085Account:${VICTIM}(wallet)`;
    const res = await POST(req({ message: 'claim spins', path }));
    if (res.status === 400) return; // refused outright: fine
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const text = (JSON.parse(init.body as string) as { text: string }).text;
    const header = text.split('\n\n')[0];
    expect(UNSAFE.test(header), JSON.stringify(header)).toBe(false);
    const accountLines = header.split(LINE_BREAKS).filter((l) => l.startsWith('Account:'));
    expect(accountLines).toEqual(['Account: signed out']);
  });

  it('a bidi override in the path never reaches the Telegram text', async () => {
    // Stored "/sloop/..." reversed: shown as "/pools" order with the override, a different page than was sent.
    const res = await POST(req({ message: 'hi', path: '/‮21/sloop' }));
    if (res.status === 400) return;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const text = (JSON.parse(init.body as string) as { text: string }).text;
    expect(text).not.toMatch(UNSAFE);
  });
});

describe('the abuse limit under a clock that is not monotonic', () => {
  it('a send stamped in an earlier hour must not reset the current hour', async () => {
    const limit = feedbackLimitKey(U1);
    const h1 = new Date(Date.UTC(2026, 9, 1, 13, 0, 1));
    const h0 = new Date(Date.UTC(2026, 9, 1, 12, 59, 59)); // two seconds earlier, previous clock hour
    for (let i = 0; i < 5; i++) expect(await reserveFeedback(tdb.db as never, limit, h1)).toBe(true);
    expect(await reserveFeedback(tdb.db as never, limit, h1)).toBe(false);
    // One request lands on an instance whose clock is two seconds behind.
    await reserveFeedback(tdb.db as never, limit, h0);
    // The 13:00 hour already holds 5 sends: a sixth in it must still be refused.
    expect(await reserveFeedback(tdb.db as never, limit, h1)).toBe(false);
  });
});
