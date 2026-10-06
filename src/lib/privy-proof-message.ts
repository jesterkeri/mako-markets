// ----------------------------------------------------------------------------
// src/lib/privy-proof-message.ts
//
// The sign-in proof (INBOX_GAP_PLAN r18, item 1, [B2]): the embedded wallet signs a TEXT message the browser builds
// itself, never bytes the server chose. Privy asks the enrolled authenticator before that wallet signs anything, so a
// valid signature means the factor was passed in this sign-in. A server that has been taken over could otherwise send
// the 32-byte hash of a Safe transfer as the "challenge" and receive a valid Safe signature at the prompt the user
// expects; a framed text message is signed under a different length prefix ([E2]).
//
// Shared by the browser (build) and the server (parse and check). Pure.
// ----------------------------------------------------------------------------

/// The nonce the server issues: 32 random bytes, base64url, no padding. The browser refuses anything else.
export const PROOF_NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
/// How long a nonce and an issued message are good for.
export const PROOF_TTL_MS = 5 * 60 * 1000;

export function buildProofMessage(site: string, nonce: string, issued: Date): string {
  if (!PROOF_NONCE_RE.test(nonce)) throw new Error('bad_proof_nonce');
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(site)) throw new Error('bad_proof_site');
  return `Mako Market sign-in\nSite: ${site}\nNonce: ${nonce}\nIssued: ${issued.toISOString()}`;
}

export type ParsedProof = { site: string; nonce: string; issued: Date };

/// Exactly the four lines buildProofMessage writes, or null. Nothing is tolerated: no extra line, no other order.
export function parseProofMessage(message: string): ParsedProof | null {
  const m = /^Mako Market sign-in\nSite: ([a-z0-9.-]+(?::\d+)?)\nNonce: ([A-Za-z0-9_-]{43})\nIssued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(message);
  if (!m) return null;
  const issued = new Date(m[3]);
  if (Number.isNaN(issued.getTime()) || issued.toISOString() !== m[3]) return null;
  return { site: m[1], nonce: m[2], issued };
}

/// The site a proof must name: the host of the app's own URL (NEXT_PUBLIC_APP_URL), so a proof signed for another
/// site is refused.
export function proofSite(appUrl: string | undefined): string {
  if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is not set');
  return new URL(appUrl.trim()).host;
}
