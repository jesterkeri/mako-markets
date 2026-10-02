// The invite card (15a), drawn for a round in the design and adapted here to a pool: the link it shares, the
// share-intent URLs for X, WhatsApp and Telegram, and what the card says. Pure, so the links and the figures are
// tested without a browser or a chain.
//
// Every figure on the card comes from the pool page's own helpers (poolRow, poolClock, usdc2), so the card and the
// page can never disagree about the same pool.

import type { MarketWithId } from './contract';
import { MIN_BET } from './pool-bet-rules';
import { formatPays, poolRow, STATE_COLOUR, stateLabel, usdc2, type PoolCat, type PoolState } from './pool-list';
import { poolClock } from './pool-rules';
import { parseRefTag } from './ref-tag';

/// Shared links always point at production, never at the preview or local host the sharer happens to be on.
export const SHARE_ORIGIN = 'https://makomarket.xyz';

/// Where a link is going. It becomes `utm_source`, so Vercel Analytics counts visits per target.
export type ShareTarget = 'x' | 'whatsapp' | 'telegram' | 'link';

/// The pool's link for one target: `https://makomarket.xyz/pools/<id>?utm_source=<target>&utm_campaign=pool-<id>`.
/// RefCapture keeps `utm_campaign` as the visitor's ref tag, so it must pass the ref rule (`^[a-z0-9-]{1,32}$`);
/// an id too long for it (never a real pool) gets no campaign rather than a tag the rule would drop.
export function poolInviteLink(id: bigint, target: ShareTarget): string {
  const params = new URLSearchParams({ utm_source: target });
  const campaign = parseRefTag(`pool-${id.toString()}`);
  if (campaign) params.set('utm_campaign', campaign);
  return `${SHARE_ORIGIN}/pools/${id.toString()}?${params.toString()}`;
}

/// The link as the card prints it: no scheme, as the design writes "makomarket.xyz/r/0142?ref=…".
export function linkDisplay(link: string): string {
  return link.replace(/^https?:\/\//, '');
}

/// The words that go with the link: "<question> on Mako Market".
export function shareText(question: string): string {
  return `${question} on Mako Market`;
}

/// The official share-intent URL for a target, every value percent-encoded (spaces as %20, never "+").
///  - X: https://x.com/intent/tweet?text=…&url=… (docs.x.com, Post Web Intent)
///  - WhatsApp: https://wa.me/?text=… (Click to Chat; the link rides in the text, the only parameter)
///  - Telegram: https://t.me/share/url?url=…&text=… (core.telegram.org/widgets/share)
export function intentUrl(target: Exclude<ShareTarget, 'link'>, id: bigint, question: string): string {
  const link = poolInviteLink(id, target);
  const text = shareText(question);
  const enc = encodeURIComponent;
  switch (target) {
    case 'x':
      return `https://x.com/intent/tweet?text=${enc(text)}&url=${enc(link)}`;
    case 'whatsapp':
      return `https://wa.me/?text=${enc(`${text} ${link}`)}`;
    case 'telegram':
      return `https://t.me/share/url?url=${enc(link)}&text=${enc(text)}`;
  }
}

export type InviteSide = {
  side: 'yes' | 'no';
  name: string;
  /// Pays per 1 USDC ("1.29x"), or null when the side has no stake to quote from (the page says "No stake yet").
  pays: string | null;
  /// USDC on the side, as the page prints it ("30.00").
  amount: string;
  bettors: number;
};

export type InviteCard = {
  state: PoolState;
  open: boolean;
  pill: { label: string; colour: string };
  cat: PoolCat;
  /// Under the title: how to bet while the pool is open, otherwise where the pool stands.
  sub: string;
  clock: { label: string; value: string };
  sides: [InviteSide, InviteSide];
  /// "Scan to join" only while bets are taken.
  scanTitle: string;
  /// The minimum bet line, only while bets are taken.
  minLine: string | null;
};

/// What the card says about a pool at `nowSec`.
export function poolInviteCard(m: MarketWithId, nowSec: number, labels: { yes: string; no: string }): InviteCard {
  const row = poolRow(m, nowSec);
  const clock = poolClock(m, row.state, nowSec);
  const open = row.state === 'open';
  const side = (s: 'yes' | 'no'): InviteSide => {
    const pays = s === 'yes' ? row.yesPays : row.noPays;
    return {
      side: s,
      name: s === 'yes' ? labels.yes : labels.no,
      pays: pays === null ? null : formatPays(pays),
      amount: usdc2(s === 'yes' ? m.totalYes : m.totalNo),
      bettors: s === 'yes' ? m.yesBettorCount : m.noBettorCount,
    };
  };
  return {
    state: row.state,
    open,
    pill: { label: stateLabel(row.state).toUpperCase(), colour: STATE_COLOUR[row.state] },
    cat: row.cat,
    sub: open ? `Bet ${labels.yes} or ${labels.no} · settled by Mako Market` : clock.sub,
    clock: { label: clock.label, value: clock.value },
    sides: [side('yes'), side('no')],
    scanTitle: open ? 'Scan to join' : 'Scan to view',
    minLine: open ? `Min ${usdc2(MIN_BET)} USDC · gas-free with email` : null,
  };
}
