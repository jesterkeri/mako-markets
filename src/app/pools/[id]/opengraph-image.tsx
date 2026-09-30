import { ImageResponse } from 'next/og';

import { marketTypeLabel } from '@/lib/contract';
import { poolIdFrom, readPoolForShare, shareStatus } from '@/lib/pool-share';

/**
 * The share preview for /pools/[id]: 1200x630, generated per request from the pool on chain (question, category,
 * status), so an unfurl names the pool rather than showing a generic card. A pool that cannot be read shows the
 * brand. Moved from /market/[id], where `params` was read as a plain object; in Next 16 it is a Promise, so every
 * preview there fell back to the brand.
 */
export const revalidate = 60;
export const alt = 'Mako Market prediction pool';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Color tokens mirror globals.css so the OG image feels like the site.
const COLORS = {
  background: '#EBE5D9',
  foreground: '#000000',
  warning: '#D94A3D',
  muted: '#79797A',
};

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsedId = poolIdFrom(id);
  const market = parsedId !== null ? await readPoolForShare(parsedId) : null;

  const question = market?.question ?? 'Mako Market';
  const tag = market ? marketTypeLabel(market.mType) : 'MAKO';
  const closeLabel = market ? shareStatus(market, Math.floor(Date.now() / 1000)).toUpperCase() : 'PREDICTION POOLS ON MONAD';

  // Font size tapers with question length so long strings still fit on one
  // card. The 1200x630 canvas comfortably fits ~90 chars at 72px.
  const qLen = question.length;
  const questionFontPx = qLen < 40 ? 96 : qLen < 70 ? 80 : qLen < 100 ? 64 : 52;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: COLORS.background,
          padding: 64,
          fontFamily: 'sans-serif',
          color: COLORS.foreground,
        }}
      >
        {/* Top band: brand + market id */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <div
              style={{
                width: 72,
                height: 72,
                backgroundColor: COLORS.foreground,
                color: COLORS.background,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 54,
                fontWeight: 900,
              }}
            >
              M
            </div>
            <div
              style={{
                fontSize: 48,
                fontWeight: 900,
                letterSpacing: '-0.02em',
                textTransform: 'uppercase',
              }}
            >
              MAKO
            </div>
          </div>
          {market ? (
            <div
              style={{
                fontSize: 22,
                fontWeight: 900,
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
                color: COLORS.muted,
              }}
            >
              {`POOL #${parsedId?.toString() ?? '?'}`}
            </div>
          ) : null}
        </div>

        {/* Middle: market question fills the main visual area */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            flex: 1,
            marginTop: 40,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 18,
              fontWeight: 900,
              letterSpacing: '0.25em',
              textTransform: 'uppercase',
              color: COLORS.warning,
              backgroundColor: `${COLORS.warning}22`,
              padding: '8px 16px',
              alignSelf: 'flex-start',
              marginBottom: 32,
            }}
          >
            {tag}
          </div>
          <div
            style={{
              fontSize: questionFontPx,
              fontWeight: 900,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              textTransform: 'uppercase',
              display: 'flex',
            }}
          >
            {question}
          </div>
        </div>

        {/* Bottom band: close-time + cta */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            borderTop: `2px solid ${COLORS.foreground}`,
            paddingTop: 24,
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 900,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: market?.resolved ? COLORS.muted : COLORS.warning,
            }}
          >
            {closeLabel}
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 900,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: COLORS.foreground,
            }}
          >
            TAP TO BET → MAKOMARKET.XYZ
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
