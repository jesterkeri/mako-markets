// Adversary r2 on feat/news-marquee@a8134f1 (Home Market intel crawl): React keys for the cards.
//
// `intelKeys` (src/app/_home/IntelStrip.tsx) promises "A story the feed happens to list twice gets a numbered key
// rather than a clash". The numbered key is the base key plus `#<n>`, and a base key is `u:<url>` with the url
// verbatim, so a story whose link carries the fragment `#1` has the same key as the second listing of the same link
// without it. Two React siblings with one key: React warns and may keep, drop or duplicate the wrong card when the
// 5-minute refetch reorders the list (the spec: every story once, never the same story twice on screen).

import { describe, expect, it } from 'vitest';

import type { IntelItem } from '@/lib/news-intel';

const { intelKeys } = await import('@/app/_home/IntelStrip');

const story = (title: string, url?: string, publishedAt?: string): IntelItem => ({ tag: 'CRYPTO', title, time: 'RECENT', url, publishedAt });

describe('intelKeys never hands two cards the same key', () => {
  it('a link listed twice, plus the same link with the fragment #1', () => {
    const items = [story('A', 'https://example.com/a'), story('A again', 'https://example.com/a'), story('Live blog, part 1', 'https://example.com/a#1')];
    const keys = intelKeys(items);
    expect(new Set(keys).size).toBe(items.length);
  });

  it('a story without a link whose title and time spell another numbered key', () => {
    const items = [story('X', undefined, 'T'), story('X', undefined, 'T'), story('X', undefined, 'T#1')];
    const keys = intelKeys(items);
    expect(new Set(keys).size).toBe(items.length);
  });
});
