import { ImageResponse } from 'next/og';
import { createPublicClient, http } from 'viem';
import { makoAbi, MarketType, type MarketWithId } from '@/lib/contract';
import { humanizeUntil } from '@/lib/time';

/**
 * Dynamic OpenGraph thumbnail for /market/[id].
 *
 * Renders 1200x630 PNG generated at request time via Next.js ImageResponse.
 * Pulls the market's question + tag + closeTime from on-chain so the
 * unfurl looks specific to the bet, not a generic Mako logo.
 *
 * Cached for 60s to match the page's revalidate window — share links
 * unfurl cheaply even on a viral post.
 */
export const revalidate = 60;
export const alt = 'Mako Market — prediction market';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const MAKO_ADDRESS = (process.env.NEXT_PUBLIC_MAKO_ADDRESS ??
  '0xf9853d7ad6601deF4367524A5802B41227ea5c43') as `0x${string}`;
const RPC_URL = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz/';

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
} as const;

async function fetchMarket(id: bigint): Promise<MarketWithId | null> {
  try {
    const client = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });
    const m = (await client.readContract({
      address: MAKO_ADDRESS,
      abi: makoAbi,
      functionName: 'getMarket',
      args: [id],
    })) as Omit<MarketWithId, 'id'>;
    if (!m || !m.question) return null;
    return { ...m, id };
  } catch {
    return null;
  }
}

function tagFor(mType: MarketType): string {
  if (mType === MarketType.FOOTBALL) return 'FOOTBALL';
  if (mType === MarketType.CRYPTO) return 'CRYPTO';
  if (mType === MarketType.BASKETBALL) return 'NBA';
  return 'EVENT';
}

// Color tokens mirror globals.css so the OG image feels like the site.
const COLORS = {
  background: '#EBE5D9',
  foreground: '#000000',
  warning: '#D94A3D',
  muted: '#79797A',
};

export default async function Image({ params }: { params: { id: string } }) {
  let parsedId: bigint | null = null;
  try {
    parsedId = BigInt(params.id);
  } catch {
    /* fall through to generic branding */
  }

  const market = parsedId !== null ? await fetchMarket(parsedId) : null;

  // Branded fallback for bad ids or chain read failures — better than a blank
  // square in someone's Discord preview.
  const question = market?.question ?? 'Mako Market';
  const tag = market ? tagFor(market.mType) : 'MAKO';
  const nowSec = Math.floor(Date.now() / 1000);
  // v4 splits "betting still open?" (bettingCloseTime) from "resolution
  // legal?" (closeTime). The unfurl reads bettingCloseTime so social
  // previews don't tell readers betting is still open during the
  // post-bettingClose / pre-resolution window (sports markets sit there
  // for the duration of the event).
  const bettingCloseSec = market ? Number(market.bettingCloseTime) : 0;
  const closeLabel = !market
    ? 'Short-form prediction markets on Monad'
    : market.resolved
      ? 'MARKET RESOLVED'
      : bettingCloseSec > nowSec
        ? `BETS CLOSE ${humanizeUntil(bettingCloseSec - nowSec).toUpperCase()}`
        : 'AWAITING RESOLUTION';

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
              MARKET #{parsedId?.toString() ?? '?'}
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
              width: 'fit-content',
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
