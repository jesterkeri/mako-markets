// Terms, privacy and risk page (23a), rendered for each `?tab=`: which tab opens, which link is current, and that
// both layouts show the same text. Both layouts render in the DOM (CSS picks one), so texts appear twice.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { LEGAL_DOCS, LEGAL_TABS, type LegalTab } from '@/lib/legal-copy';

vi.mock('next/link', () => ({
  default: ({ href, children, replace, ...rest }: { href: string; children: React.ReactNode; replace?: boolean }) => (
    <a href={href} data-replace={replace ? 'true' : undefined} {...rest}>
      {children}
    </a>
  ),
}));

const { default: LegalPage, generateMetadata } = await import('@/app/legal/page');

async function renderTab(tab: string | string[] | undefined) {
  const el = await LegalPage({ searchParams: Promise.resolve(tab === undefined ? {} : { tab }) });
  return render(el);
}

afterEach(cleanup);

describe('legal page', () => {
  it.each(LEGAL_TABS.map((t) => [t]))('?tab=%s opens that tab on both layouts', async (tab: LegalTab) => {
    await renderTab(tab);
    const doc = LEGAL_DOCS[tab];
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([doc.title, doc.title]);
    expect(screen.getAllByText(doc.note)).toHaveLength(2);
    for (const sec of doc.sections) {
      expect(screen.getAllByRole('heading', { level: 2, name: sec.h })).toHaveLength(2);
      expect(screen.getAllByText(sec.p)).toHaveLength(2);
    }
    // Only the open tab's text is on the page.
    for (const other of LEGAL_TABS.filter((t) => t !== tab)) {
      expect(screen.queryAllByText(LEGAL_DOCS[other].note)).toHaveLength(0);
    }
  });

  it('marks exactly the open tab as current, and links every tab by its query value', async () => {
    await renderTab('risk');
    const current = document.querySelectorAll('a[aria-current="page"]');
    expect([...current].map((a) => a.getAttribute('href'))).toEqual(['/legal?tab=risk', '/legal?tab=risk']);
    expect([...current].map((a) => a.textContent)).toEqual(['RISK NOTICE', 'Risk']);
    const hrefs = [...document.querySelectorAll('nav[aria-label="Legal"] a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([...LEGAL_TABS, ...LEGAL_TABS].map((t) => `/legal?tab=${t}`));
    // Switching tabs replaces the history entry rather than stacking one per tab.
    for (const a of document.querySelectorAll('nav[aria-label="Legal"] a')) expect(a.getAttribute('data-replace')).toBe('true');
  });

  it.each([[undefined], ['nope'], [['privacy', 'risk']]])('?tab=%j falls back sensibly', async (tab) => {
    await renderTab(tab);
    const want = Array.isArray(tab) ? LEGAL_DOCS.privacy.title : LEGAL_DOCS.terms.title;
    expect(screen.getAllByRole('heading', { level: 1 })[0].textContent).toBe(want);
  });

  it('shows the update date on both layouts as a machine-readable time', async () => {
    await renderTab('terms');
    const times = [...document.querySelectorAll('time')];
    expect(times.map((t) => [t.getAttribute('datetime'), t.textContent])).toEqual([
      ['2026-09-30', 'LAST UPDATED 30 SEP 2026'],
      ['2026-09-30', 'Updated 30 Sep 2026'],
    ]);
  });

  it('titles the browser tab after the open legal tab', async () => {
    expect(await generateMetadata({ searchParams: Promise.resolve({ tab: 'privacy' }) })).toEqual({ title: 'Privacy · Mako Market' });
    expect(await generateMetadata({ searchParams: Promise.resolve({}) })).toEqual({ title: 'Terms of use · Mako Market' });
  });
});
