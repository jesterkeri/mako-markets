import { notFound } from 'next/navigation';
import { devPagesAllowed } from '@/lib/dev-pages';

import { ListStateDesktop, ListStateMobile } from '@/components/ListState';
import type { ListKind } from '@/lib/list-states';

export const dynamic = 'force-dynamic';

const KINDS: ListKind[] = ['rounds', 'pools', 'me'];
const STATES = ['empty', 'loading', 'error'] as const;

/// Dev-only preview of the shared list states (16a): /dev/list-states?kind=rounds&state=empty. Gated like the
/// other /dev pages; production answers 404.
export default async function DevListStatesPage({ searchParams }: { searchParams: Promise<{ kind?: string; state?: string }> }) {
  if (!devPagesAllowed()) notFound();
  const q = await searchParams;
  const kind = KINDS.find((k) => k === q.kind) ?? 'rounds';
  const state = STATES.find((s) => s === q.state) ?? 'empty';
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <div style={{ padding: '18px 4px 22px' }}>
          <h1 style={{ margin: 0, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 64, lineHeight: 1, letterSpacing: '-0.04em', textTransform: 'capitalize' }}>{kind}</h1>
        </div>
        <ListStateDesktop kind={kind} state={state} explorerHref="https://testnet.monadvision.com/address/0x0000000000000000000000000000000000000000" />
      </div>
      <div className="mk-mob mk-m">
        <div style={{ padding: '6px 20px 0' }}>
          <h1 style={{ margin: 0, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 40, lineHeight: 1, letterSpacing: '-0.035em', textTransform: 'capitalize' }}>{kind}</h1>
        </div>
        <ListStateMobile kind={kind} state={state} />
      </div>
    </>
  );
}
