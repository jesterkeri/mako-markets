/// "BETA" beside the wordmark: Mako Market is in beta, and says so on every page (Joshua, 2026-09-30).
export function BetaTag({ size = 'desktop' }: { size?: 'desktop' | 'mobile' }) {
  const mobile = size === 'mobile';
  return (
    <span
      style={{
        flex: 'none',
        height: mobile ? 20 : 22,
        display: 'inline-flex',
        alignItems: 'center',
        padding: mobile ? '0 7px' : '0 8px',
        borderRadius: 6,
        background: 'var(--mako-signal)',
        color: '#000',
        boxShadow: 'var(--edge)',
        fontFamily: 'var(--mako-font-mono)',
        fontSize: mobile ? 10 : 11,
        fontWeight: 800,
        letterSpacing: '0.14em',
      }}
    >
      BETA
    </span>
  );
}
