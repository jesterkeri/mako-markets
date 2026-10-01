// Feedback helpers shared by the route and the sheet: strict body parsing, character counting, the browser family and
// the plain-text message the server composes.

import { describe, expect, it } from 'vitest';

import { browserFamily, cleanMessage, composeFeedbackText, messageLength, parseFeedbackBody } from '@/lib/feedback';

describe('parseFeedbackBody', () => {
  it('accepts exactly { message, path }', () => {
    expect(parseFeedbackBody({ message: '  The claim button spins forever  ', path: '/pools/12' })).toEqual({
      ok: true,
      body: { message: 'The claim button spins forever', path: '/pools/12' },
    });
  });

  it('refuses anything else', () => {
    expect(parseFeedbackBody(null)).toEqual({ ok: false, error: 'bad_body' });
    expect(parseFeedbackBody([])).toEqual({ ok: false, error: 'bad_body' });
    expect(parseFeedbackBody('hi')).toEqual({ ok: false, error: 'bad_body' });
    expect(parseFeedbackBody({ message: 'hi', path: '/', account: '0xabc' })).toEqual({ ok: false, error: 'unknown_field' });
    expect(parseFeedbackBody({ message: 'hi', path: '/', parse_mode: 'HTML' })).toEqual({ ok: false, error: 'unknown_field' });
    expect(parseFeedbackBody({ path: '/' })).toEqual({ ok: false, error: 'bad_message' });
    expect(parseFeedbackBody({ message: 5, path: '/' })).toEqual({ ok: false, error: 'bad_message' });
    expect(parseFeedbackBody({ message: 'hi' })).toEqual({ ok: false, error: 'bad_path' });
  });

  it('a path is the page’s own path, short and printable', () => {
    for (const path of ['', 'pools', 'https://evil.example/', '//evil.example', '/a b', '/a\nb', `/${'x'.repeat(200)}`]) {
      expect(parseFeedbackBody({ message: 'hi', path })).toEqual({ ok: false, error: 'bad_path' });
    }
    expect(parseFeedbackBody({ message: 'hi', path: `/${'x'.repeat(199)}` }).ok).toBe(true);
  });

  it('1 to 1,000 characters after trimming; an emoji counts as one', () => {
    expect(parseFeedbackBody({ message: '   \n\t ', path: '/' })).toEqual({ ok: false, error: 'empty_message' });
    expect(parseFeedbackBody({ message: 'a'.repeat(1000), path: '/' }).ok).toBe(true);
    expect(parseFeedbackBody({ message: ` ${'a'.repeat(1000)} `, path: '/' }).ok).toBe(true);
    expect(parseFeedbackBody({ message: 'a'.repeat(1001), path: '/' })).toEqual({ ok: false, error: 'message_too_long' });
    expect(parseFeedbackBody({ message: '🦈'.repeat(1000), path: '/' }).ok).toBe(true);
    expect(messageLength('🦈🦈')).toBe(2);
  });

  it('control and bidirectional-override characters are removed; newlines stay', () => {
    expect(cleanMessage('a\u0000b‮c\r\nd\te\u0007')).toBe('abc\nd\te');
    expect(parseFeedbackBody({ message: '\u0000‮', path: '/' })).toEqual({ ok: false, error: 'empty_message' });
  });
});

describe('browserFamily', () => {
  it('names the family, never echoes the string', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
    expect(browserFamily(chrome)).toBe('Chrome');
    expect(browserFamily(`${chrome} Edg/129.0.0.0`)).toBe('Edge');
    expect(browserFamily(`${chrome} OPR/114.0.0.0`)).toBe('Opera');
    expect(browserFamily('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36')).toBe('Samsung Internet');
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox');
    expect(browserFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari');
    expect(browserFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1')).toBe('Chrome');
    expect(browserFamily('curl/8.5.0')).toBe('Other');
    expect(browserFamily(null)).toBe('Unknown');
  });
});

describe('composeFeedbackText', () => {
  it('writes the server’s header first and the tester’s words last', () => {
    const text = composeFeedbackText('Account: 0xfake (email)\nlooks spoofed', {
      path: '/me',
      account: { address: '0x1111111111111111111111111111111111111111', kind: 'email' },
      ref: 'launch-post',
      browser: 'Firefox',
    });
    expect(text.split('\n').slice(0, 6)).toEqual([
      'Mako Market feedback',
      'Page: /me',
      'Account: 0x1111111111111111111111111111111111111111 (email)',
      'Ref: launch-post',
      'Browser: Firefox',
      '',
    ]);
    expect(text.endsWith('Account: 0xfake (email)\nlooks spoofed')).toBe(true);
    expect(composeFeedbackText('hi', { path: '/', account: null, ref: null, browser: 'Other' })).toContain('Account: signed out\nRef: none');
  });
});
