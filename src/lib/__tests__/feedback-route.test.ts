// POST /api/feedback: the gate order, strict bodies, the abuse limit (real Postgres via pglite), the plain-text
// Telegram payload, the missing-configuration answer, and that the bot token never appears in a response or a log.
// fetch is mocked: nothing reaches Telegram.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSafeAddress } from '@/lib/safe';

import { createFeedbackTestDb, type FeedbackTestDb } from './feedback-test-db';

const TOKEN = '7654321:AAF-very-secret-feedback-token';
const CHAT = '-1001234567890';
const EOA = '0x00000000000000000000000000000000000000a1' as const;
const WALLET = '0x2222222222222222222222222222222222222222';

const state = vi.hoisted(() => ({
  db: null as unknown,
  originOk: true,
  session: null as unknown,
  sessionThrows: false,
}));

vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: state.originOk }) }));
vi.mock('@/lib/user-session', () => ({
  getUserSession: () => (state.sessionThrows ? Promise.reject(new Error(`boom ${TOKEN}`)) : Promise.resolve(state.session)),
}));

const { POST } = await import('@/app/api/feedback/route');

const magic = (userId: string) => ({ authType: 'magic', userId, email: 'a@b.co', magicEoa: EOA, walletAddress: null, sessionId: 's1' });
const wallet = (userId: string) => ({ authType: 'wallet', userId, email: null, magicEoa: null, walletAddress: WALLET, sessionId: 's2' });
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const UA_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA_FIREFOX, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const ok = { message: 'The claim button on pool 12 spins forever.', path: '/pools/12' };

let tdb: FeedbackTestDb;
let fetchMock: ReturnType<typeof vi.fn>;
let logs: unknown[][];

function telegramOk() {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  tdb = await createFeedbackTestDb();
  state.db = tdb.db;
  state.originOk = true;
  state.session = null;
  state.sessionThrows = false;
  process.env.FEEDBACK_TELEGRAM_BOT_TOKEN = `${TOKEN}\n`;
  process.env.FEEDBACK_TELEGRAM_CHAT_ID = ` ${CHAT} `;
  fetchMock = vi.fn(async () => telegramOk());
  vi.stubGlobal('fetch', fetchMock);
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FEEDBACK_TELEGRAM_BOT_TOKEN;
  delete process.env.FEEDBACK_TELEGRAM_CHAT_ID;
  await tdb.close();
});

async function send(body: unknown = ok, headers?: Record<string, string>) {
  const res = await POST(req(body, headers));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

function sentPayload(call = 0): { url: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return { url, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

describe('POST /api/feedback: gates', () => {
  it('refuses a cross-origin request before anything else', async () => {
    state.originOk = false;
    expect(await send()).toMatchObject({ status: 403, json: { error: 'cross_origin' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 503 feedback_unavailable when the bot is not configured, and sends nothing', async () => {
    delete process.env.FEEDBACK_TELEGRAM_BOT_TOKEN;
    expect(await send()).toMatchObject({ status: 503, json: { error: 'feedback_unavailable' } });
    process.env.FEEDBACK_TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.FEEDBACK_TELEGRAM_CHAT_ID = '   ';
    expect(await send()).toMatchObject({ status: 503, json: { error: 'feedback_unavailable' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the body strictly', async () => {
    expect(await send('not json')).toMatchObject({ status: 400, json: { error: 'bad_body' } });
    expect(await send([ok])).toMatchObject({ status: 400, json: { error: 'bad_body' } });
    expect(await send({ ...ok, chat_id: 1 })).toMatchObject({ status: 400, json: { error: 'unknown_field' } });
    expect(await send({ ...ok, message: '   ' })).toMatchObject({ status: 400, json: { error: 'empty_message' } });
    expect(await send({ ...ok, message: 'x'.repeat(1001) })).toMatchObject({ status: 400, json: { error: 'message_too_long' } });
    expect(await send({ ...ok, path: 'https://evil.example' })).toMatchObject({ status: 400, json: { error: 'bad_path' } });
    expect(await send(JSON.stringify({ ...ok, message: 'x'.repeat(20_000) }))).toMatchObject({ status: 413, json: { error: 'too_large' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 1,000-character message is accepted', async () => {
    expect(await send({ ...ok, message: 'x'.repeat(1000) })).toMatchObject({ status: 200, json: { ok: true } });
  });
});

describe('POST /api/feedback: the Telegram message', () => {
  it('goes to sendMessage as plain text, with the server’s header and the tester’s words', async () => {
    expect(await send(ok, { cookie: 'mako_ref=Launch-Post; other=1' })).toMatchObject({ status: 200, json: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, body } = sentPayload();
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(body).toEqual({
      chat_id: CHAT,
      text: ['Mako Market feedback', 'Page: /pools/12', 'Account: signed out', 'Ref: launch-post', 'Browser: Firefox', '', ok.message].join('\n'),
      link_preview_options: { is_disabled: true },
    });
    expect(body).not.toHaveProperty('parse_mode');
    expect(body).not.toHaveProperty('entities');
  });

  it('adds the Mako wallet for an email account and the wallet for a wallet account', async () => {
    state.session = magic(U1);
    await send();
    expect(sentPayload(0).body.text).toContain(`Account: ${deriveSafeAddress(EOA)} (email)`);
    state.session = wallet(U2);
    await send();
    expect(sentPayload(1).body.text).toContain(`Account: ${WALLET} (wallet)`);
  });

  it('a markup-looking message is sent as the same characters, never as formatting', async () => {
    const message = '<b>Mako Market</b> [verify here](https://evil.example) *now*';
    await send({ ...ok, message });
    const { body } = sentPayload();
    expect((body.text as string).endsWith(`\n\n${message}`)).toBe(true);
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('a broken session check sends as signed out rather than failing', async () => {
    state.sessionThrows = true;
    expect((await send()).status).toBe(200);
    expect(sentPayload().body.text).toContain('Account: signed out');
  });

  it('Telegram refusing or unreachable is a 502, not a pretend success', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }));
    expect(await send()).toMatchObject({ status: 502, json: { error: 'send_failed' } });
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 200 }));
    expect(await send()).toMatchObject({ status: 502, json: { error: 'send_failed' } });
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
    expect(await send()).toMatchObject({ status: 502, json: { error: 'send_failed' } });
  });
});

describe('POST /api/feedback: the abuse limit', () => {
  it('5 an hour per account, then 429 rate_limited without sending', async () => {
    state.session = magic(U1);
    for (let i = 0; i < 5; i++) expect((await send()).status).toBe(200);
    expect(await send()).toMatchObject({ status: 429, json: { error: 'rate_limited' } });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Another account has its own five.
    state.session = wallet(U2);
    expect((await send()).status).toBe(200);
  });

  it('30 an hour shared by every signed-out sender', async () => {
    for (let i = 0; i < 30; i++) expect((await send()).status).toBe(200);
    expect(await send()).toMatchObject({ status: 429, json: { error: 'rate_limited' } });
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it('a rejected body or a missing bot consumes nothing', async () => {
    state.session = magic(U1);
    for (let i = 0; i < 10; i++) await send({ ...ok, message: '' });
    delete process.env.FEEDBACK_TELEGRAM_BOT_TOKEN;
    for (let i = 0; i < 10; i++) await send();
    process.env.FEEDBACK_TELEGRAM_BOT_TOKEN = TOKEN;
    for (let i = 0; i < 5; i++) expect((await send()).status).toBe(200);
  });

  it('no limit means no send: a database failure is a 503', async () => {
    state.db = { transaction: () => Promise.reject(new Error('connection refused')) };
    expect(await send()).toMatchObject({ status: 503, json: { error: 'limit_unavailable' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/feedback: the token never leaks', () => {
  it('no response and no console line carries the token or the Telegram URL', async () => {
    const texts: string[] = [];
    texts.push((await send()).text);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: `bad token ${TOKEN}` }), { status: 401 }));
    texts.push((await send()).text);
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
    texts.push((await send()).text);
    state.sessionThrows = true;
    texts.push((await send()).text);
    state.db = { transaction: () => Promise.reject(new Error(`db down ${TOKEN}`)) };
    texts.push((await send()).text);
    const everything = JSON.stringify(texts) + JSON.stringify(logs, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v));
    expect(logs.length).toBeGreaterThan(0);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('AAF-very-secret');
    expect(everything).not.toContain('api.telegram.org');
    expect(everything).not.toContain(CHAT);
  });
});
