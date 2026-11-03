import 'server-only';

import QRCode from 'qrcode';

import { poolUrl } from './pool-share';

/// The bet placed card's QR code: the pool's page, so whoever scans it can take the other side (SPEC.md). Encoded on
/// the server as an SVG data URL, dark on the tile's cream so every scanner reads it, and no quiet zone (the tile adds
/// the padding). qrcode.react's components use React hooks, which ImageResponse cannot run.
export async function poolQr(id: bigint): Promise<string> {
  const svg = await QRCode.toString(poolUrl(id), { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#0A0A0AFF', light: '#EDE6D6FF' } });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
