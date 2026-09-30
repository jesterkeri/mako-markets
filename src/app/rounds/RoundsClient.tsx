'use client';

import { ListStateDesktop, ListStateMobile } from '@/components/ListState';

export function RoundsClient() {
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <h1 style={{ margin: '22px 0 20px', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 56, lineHeight: 1, letterSpacing: '-0.04em' }}>Rounds</h1>
        <ListStateDesktop kind="rounds" state="not_open" />
      </div>
      <div className="mk-mob mk-m">
        <ListStateMobile kind="rounds" state="not_open" />
      </div>
    </>
  );
}
