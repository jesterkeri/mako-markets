// Market intel on Home (2a): the body is parsed defensively, the newest four show in the route's order, and each
// item's age is worked out in the browser from publishedAt, so it does not go stale with the route's 15-minute cache.

import { describe, expect, it } from 'vitest';

import { latestIntel, newsAge, parseNews, type IntelItem } from '../news-intel';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

describe('parseNews', () => {
  it('keeps items in the route order with their tag, title, time, link and publish time', () => {
    const body = {
      items: [
        { kind: 'headline', tag: 'CRYPTO', title: 'Bitcoin holds above $75K', time: '2M AGO', url: 'https://www.coindesk.com/a', publishedAt: ago(120) },
        { kind: 'event', tag: 'NBA', title: 'Lakers 112, Celtics 108', time: '1H AGO', publishedAt: ago(3_600) },
      ],
    };
    expect(parseNews(body)).toEqual([
      { tag: 'CRYPTO', title: 'Bitcoin holds above $75K', time: '2M AGO', url: 'https://www.coindesk.com/a', publishedAt: ago(120) },
      { tag: 'NBA', title: 'Lakers 112, Celtics 108', time: '1H AGO', url: undefined, publishedAt: ago(3_600) },
    ]);
  });

  it('reads the old body without publishedAt (a response cached before the route kept it)', () => {
    expect(parseNews({ items: [{ tag: 'FOOTBALL', title: 'Arsenal 2-1 Chelsea · FT', time: '43M AGO' }] })).toEqual([
      { tag: 'FOOTBALL', title: 'Arsenal 2-1 Chelsea · FT', time: '43M AGO', url: undefined, publishedAt: undefined },
    ]);
  });

  it('never keeps a link that is not http(s)', () => {
    const [a, b] = parseNews({
      items: [
        { tag: 'CRYPTO', title: 'One', time: '', url: 'javascript:alert(1)' },
        { tag: 'CRYPTO', title: 'Two', time: '', url: 'HTTP://example.com/x' },
      ],
    })!;
    expect(a.url).toBeUndefined();
    expect(b.url).toBe('HTTP://example.com/x');
  });

  it('drops malformed items and unknown tags rather than drawing them', () => {
    const items = parseNews({
      items: [null, 'text', { tag: 'FOREX', title: 'Euro firms', time: '' }, { tag: 'CRYPTO', title: '   ', time: '' }, { tag: 'CRYPTO' }, { tag: 'NBA', title: ' Kept ', time: 7 }],
    });
    expect(items).toEqual([{ tag: 'NBA', title: 'Kept', time: '', url: undefined, publishedAt: undefined }]);
  });

  it('treats a body that is not the route shape as a failed read, and an empty list as empty', () => {
    expect(parseNews(null)).toBeNull();
    expect(parseNews([])).toBeNull();
    expect(parseNews({ items: 'nope' })).toBeNull();
    expect(parseNews({ error: 'boom' })).toBeNull();
    expect(parseNews({ items: [] })).toEqual([]);
  });
});

describe('latestIntel', () => {
  const item = (title: string): IntelItem => ({ tag: 'CRYPTO', title, time: '' });
  it('takes the first n in the route order (newest first)', () => {
    const all = ['a', 'b', 'c', 'd', 'e', 'f'].map(item);
    expect(latestIntel(all, 4).map((i) => i.title)).toEqual(['a', 'b', 'c', 'd']);
    expect(latestIntel(all.slice(0, 2), 4)).toHaveLength(2);
    expect(latestIntel(all, 0)).toEqual([]);
  });
});

describe('newsAge', () => {
  it('counts from publishedAt in the design units', () => {
    expect(newsAge(ago(30), 'RECENT', NOW)).toEqual({ short: 'Now', long: 'JUST NOW' });
    expect(newsAge(ago(60), 'RECENT', NOW)).toEqual({ short: '1M', long: '1M AGO' });
    expect(newsAge(ago(43 * 60 + 59), 'RECENT', NOW)).toEqual({ short: '43M', long: '43M AGO' });
    expect(newsAge(ago(3_600), 'RECENT', NOW)).toEqual({ short: '1H', long: '1H AGO' });
    expect(newsAge(ago(23 * 3_600 + 3_599), 'RECENT', NOW)).toEqual({ short: '23H', long: '23H AGO' });
    expect(newsAge(ago(86_400 * 3 + 5), 'RECENT', NOW)).toEqual({ short: '3D', long: '3D AGO' });
  });

  it('keeps ageing as the clock moves, whatever the cached time says', () => {
    const published = ago(43 * 60);
    expect(newsAge(published, '43M AGO', NOW).long).toBe('43M AGO');
    expect(newsAge(published, '43M AGO', NOW + 15 * 60_000).long).toBe('58M AGO');
    expect(newsAge(published, '43M AGO', NOW + 20 * 60_000).long).toBe('1H AGO');
  });

  it('falls back to the server time when the date is missing, unreadable or far in the future', () => {
    expect(newsAge(undefined, '43M AGO', NOW)).toEqual({ short: '43M AGO', long: '43M AGO' });
    expect(newsAge('not a date', 'RECENT', NOW)).toEqual({ short: 'RECENT', long: 'RECENT' });
    expect(newsAge(new Date(NOW + 10 * 60_000).toISOString(), 'RECENT', NOW)).toEqual({ short: 'RECENT', long: 'RECENT' });
    expect(newsAge(ago(120), 'RECENT', Number.NaN)).toEqual({ short: 'RECENT', long: 'RECENT' });
  });

  it('reads a date a few seconds ahead of the browser clock as just now (clock skew)', () => {
    expect(newsAge(new Date(NOW + 20_000).toISOString(), 'RECENT', NOW)).toEqual({ short: 'Now', long: 'JUST NOW' });
  });
});
