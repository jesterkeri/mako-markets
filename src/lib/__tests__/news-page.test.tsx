// Market intel (3a) at /news: the whole feed, the design's category pills for the tags the feed has, the newest story
// as the lead, the rest by age worked out in the browser, links that open the source safely, an honest failure, and
// Home's "All news" link to it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { HomeDesktop } from '@/app/_home/HomeDesktop';
import { HomeMobile } from '@/app/_home/HomeMobile';
import { NewsClient } from '@/app/news/NewsClient';
import { newsGroup, newsSource } from '@/lib/news-intel';
import { hasOwnMobileHeader, isMobileDetail } from '@/lib/shell-nav';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const FEED = {
  items: [
    { kind: 'headline', tag: 'CRYPTO', title: 'SEC maps out crypto custody', time: '8M AGO', url: 'https://www.coindesk.com/policy/sec', publishedAt: ago(10) },
    { kind: 'headline', tag: 'FOOTBALL', title: 'City charges explained', time: '25M AGO', url: 'https://www.espn.com/soccer/story/1', publishedAt: ago(25) },
    { kind: 'event', tag: 'NBA', title: 'Lakers 112, Warriors 108', time: '2H AGO', publishedAt: ago(120) },
    { kind: 'headline', tag: 'FOOTBALL', title: 'A link that is not http', time: '3H AGO', url: 'javascript:alert(1)', publishedAt: ago(130) },
    { kind: 'headline', tag: 'CRYPTO', title: 'Two days old', time: '2D AGO', url: 'https://www.coindesk.com/old', publishedAt: ago(2 * 24 * 60) },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async () => new Response(JSON.stringify(FEED), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewsClient />
    </QueryClientProvider>,
  );
}

describe('/news', () => {
  it('reads the whole feed: the newest is the lead, the rest by age, with counts and sources', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('SEC maps out crypto custody').length).toBeGreaterThan(0));
    expect(screen.getByText('LATEST · 5 stories')).toBeTruthy();
    expect(screen.queryByText(/^LIVE/)).toBeNull();
    expect(screen.getAllByText('10M AGO · coindesk.com').length).toBe(1);
    for (const g of ['LAST HOUR', 'EARLIER TODAY', 'EARLIER']) expect(screen.getByText(g)).toBeTruthy();
    expect(screen.getAllByText('Two days old').length).toBeGreaterThan(0);
  });

  it('links open the source in a new tab, http(s) only', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('City charges explained').length).toBeGreaterThan(0));
    const links = screen.getAllByRole('link', { name: /City charges explained/ });
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('href')).toBe('https://www.espn.com/soccer/story/1');
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(screen.queryAllByRole('link', { name: /A link that is not http/ })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: /Lakers 112/ })).toHaveLength(0);
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('category pills are the tags the feed has, and filter it', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('SEC maps out crypto custody').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual(['ALL', 'All']);
    expect(screen.queryByRole('button', { name: 'FOREX' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'FOOTBALL' }));
    expect(screen.getByText('LATEST · 2 stories')).toBeTruthy();
    expect(screen.queryAllByText('SEC maps out crypto custody')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('LATEST · 5 stories')).toBeTruthy();
  });

  it('a category with no story says so', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [FEED.items[0]] }), { status: 200 }));
    mount();
    await waitFor(() => expect(screen.getAllByText('SEC maps out crypto custody').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'NBA' })[0]);
    expect(screen.getByText('No NBA stories right now.')).toBeTruthy();
  });

  it('a failed read says news is unavailable, never an empty feed', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 502 }));
    mount();
    await waitFor(() => expect(screen.getAllByText('News is unavailable right now.').length).toBe(2), { timeout: 5000 });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 }));
    cleanup();
    mount();
    await waitFor(() => expect(screen.getAllByText('News is unavailable right now.').length).toBe(2), { timeout: 5000 });
  });

  it('related pools and rounds are not linked to stories yet, so they show as coming soon', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('SEC maps out crypto custody').length).toBeGreaterThan(0));
    expect(screen.getAllByLabelText('Related round, coming soon').length).toBe(2);
    expect(screen.getAllByLabelText('Related pool, coming soon').length).toBe(8);
  });
});

describe('helpers', () => {
  it('newsSource is the link’s host, or null', () => {
    expect(newsSource('https://www.espn.com/x')).toBe('espn.com');
    expect(newsSource('https://coindesk.com/x')).toBe('coindesk.com');
    expect(newsSource(undefined)).toBeNull();
    expect(newsSource('not a url')).toBeNull();
  });

  it('newsGroup: last hour, earlier the same day, then earlier; bad or future dates go last', () => {
    expect(newsGroup(ago(59), NOW)).toBe('last');
    expect(newsGroup(ago(61), NOW)).toBe('today');
    expect(newsGroup(ago(3 * 24 * 60), NOW)).toBe('earlier');
    expect(newsGroup(undefined, NOW)).toBe('earlier');
    expect(newsGroup('garbage', NOW)).toBe('earlier');
    expect(newsGroup(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBe('earlier');
  });

  it('/news draws its own mobile header and keeps the tab bar', () => {
    expect(hasOwnMobileHeader('/news')).toBe(true);
    expect(hasOwnMobileHeader('/news/x')).toBe(false);
    expect(isMobileDetail('/news')).toBe(false);
  });
});

describe('Home', () => {
  it('Market intel links to /news on both layouts', () => {
    act(() => {
      render(<HomeDesktop pools={{ status: 'loading' }} filter="ALL" setFilter={() => {}} labelsOf={() => ({ yes: 'YES', no: 'NO' })} retry={() => {}} news={{ status: 'unavailable' }} nowMs={NOW} />);
      render(<HomeMobile pools={{ status: 'loading' }} labelsOf={() => ({ yes: 'YES', no: 'NO' })} retry={() => {}} news={{ status: 'unavailable' }} nowMs={NOW} />);
    });
    expect(screen.getByRole('link', { name: 'All news →' }).getAttribute('href')).toBe('/news');
    expect(screen.getByRole('link', { name: 'All news' }).getAttribute('href')).toBe('/news');
  });
});
