import type { Metadata } from 'next';
import Link from 'next/link';

import {
  LEGAL_DOCS,
  LEGAL_TABS,
  LEGAL_UPDATED_ISO,
  legalHref,
  legalUpdatedLabel,
  parseLegalTab,
  type LegalTab,
} from '@/lib/legal-copy';

import s from './legal.module.css';

type Props = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const tab = parseLegalTab((await searchParams).tab);
  return { title: `${LEGAL_DOCS[tab].title} · Mako Market` };
}

/// Terms, privacy and risk (23a): one page, three tabs picked by `?tab=` (an unknown value opens Terms). Each tab
/// opens with the one thing to know, then short plain sections. The text lives in src/lib/legal-copy.ts.
export default async function LegalPage({ searchParams }: Props) {
  const tab = parseLegalTab((await searchParams).tab);
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <LegalDesktop tab={tab} />
      </div>
      <div className="mk-mob mk-m">
        <LegalMobile tab={tab} />
      </div>
    </>
  );
}

/// Desktop (2a terminal look): mono side list on the left, the text column on the right.
function LegalDesktop({ tab }: { tab: LegalTab }) {
  const doc = LEGAL_DOCS[tab];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 48, padding: '24px 4px 48px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <nav aria-label="Legal" style={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'start', position: 'sticky', top: 24 }}>
        {LEGAL_TABS.map((t) => (
          <Link key={t} href={legalHref(t)} replace aria-current={t === tab ? 'page' : undefined} className={s.deskTab}>
            {LEGAL_DOCS[t].labelDesk}
          </Link>
        ))}
      </nav>
      <article style={{ maxWidth: 680, minWidth: 0 }}>
        <time dateTime={LEGAL_UPDATED_ISO} style={{ display: 'block', fontFamily: 'var(--mako-font-mono)', fontSize: 11, color: 'var(--dim)', letterSpacing: '.08em' }}>
          {legalUpdatedLabel('desk')}
        </time>
        <h1 style={{ margin: '10px 0 0', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 44, lineHeight: 1.05, letterSpacing: '-0.035em' }}>{doc.title}</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginTop: 18, padding: '14px 16px', borderRadius: 12, boxShadow: 'inset 0 0 0 1.5px var(--mako-signal)' }}>
          <span aria-hidden="true" style={{ flex: 'none', width: 8, height: 8, marginTop: 7, borderRadius: '50%', background: 'var(--mako-signal)' }} />
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, fontWeight: 600 }}>{doc.note}</p>
        </div>
        {doc.sections.map((sec) => (
          <section key={sec.h} style={{ padding: '20px 0 4px' }}>
            <h2 style={{ margin: 0, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 20, letterSpacing: '-0.01em' }}>{sec.h}</h2>
            <p style={{ margin: '8px 0 0', fontSize: 16, lineHeight: 1.65, color: 'var(--dim)' }}>{sec.p}</p>
          </section>
        ))}
      </article>
    </div>
  );
}

/// Mobile (Material 3 Expressive): segmented tabs, the date and title, the note as a yellow tile, then the sections.
function LegalMobile({ tab }: { tab: LegalTab }) {
  const doc = LEGAL_DOCS[tab];
  return (
    <>
      <nav aria-label="Legal" style={{ padding: '4px 16px 0' }}>
        <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 9999, background: 'var(--raise)' }}>
          {LEGAL_TABS.map((t) => (
            <Link key={t} href={legalHref(t)} replace aria-current={t === tab ? 'page' : undefined} className={`${s.mobTab} m3-press`}>
              {LEGAL_DOCS[t].labelMob}
            </Link>
          ))}
        </div>
      </nav>
      <article>
        <div style={{ padding: '18px 20px 0' }}>
          <time dateTime={LEGAL_UPDATED_ISO} style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--dim)' }}>
            {legalUpdatedLabel('mob')}
          </time>
          <h1 style={{ margin: '4px 0 0', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 32, lineHeight: 1.1, letterSpacing: '-0.03em' }}>{doc.title}</h1>
        </div>
        <div style={{ padding: '14px 12px 0' }}>
          <p style={{ margin: 0, borderRadius: 24, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', padding: '14px 16px', fontSize: 15, lineHeight: 1.45, fontWeight: 700 }}>
            {doc.note}
          </p>
        </div>
        <div style={{ padding: '6px 20px 36px' }}>
          {doc.sections.map((sec) => (
            <section key={sec.h} style={{ paddingTop: 18 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>{sec.h}</h2>
              <p style={{ margin: '6px 0 0', fontSize: 15, lineHeight: 1.6, color: 'var(--dim)' }}>{sec.p}</p>
            </section>
          ))}
        </div>
      </article>
    </>
  );
}
