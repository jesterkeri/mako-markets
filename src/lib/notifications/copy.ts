// ----------------------------------------------------------------------------
// #214 Notification copy (NOTIFICATIONS_PLAN r8 §6). One pure render(n) -> {title, body, href}, shared by the panel,
// the page and (S2) the email. It renders only what the producers computed: enums, decimal ids, a count, a symbol
// from the allowlist and a number. There is never a pool question, comment text, name or address in a notification,
// so nothing here can carry phishing text. Copy rules (tested): brand "Mako Market", no we/our/us/team, no em dashes.
// Times use the viewer's zone in-app (pass `timeZone: 'UTC'` for email).
// ----------------------------------------------------------------------------

import { V1_ASSET } from '@/lib/rounds-model';

import type { NotificationKind } from './prefs';

export interface NotificationView {
  kind: NotificationKind | string;
  data: unknown;
}

export interface Rendered {
  title: string;
  body: string;
  href: string;
}

const ID_RE = /^[0-9]{1,78}$/;

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const id = (v: unknown): string | null => (typeof v === 'string' && ID_RE.test(v) ? v : null);

const FALLBACK: Rendered = { title: 'Notification', body: 'Details are on Me.', href: '/me' };

const REFUND_REASON: Record<string, string> = {
  one_sided: 'Only one side had entries.',
  tie: 'The close price matched the start price.',
  no_price: 'No price report arrived in time.',
};

function clock(v: unknown, timeZone?: string): string | null {
  const t = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(t));
}

function money(v: unknown): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
}

function poolOrRound(kind: 'claim' | 'result', d: Record<string, unknown>): Rendered {
  const n = id(d.id);
  if (!n) return FALLBACK;
  if (d.t === 'pool') {
    const out = d.outcome === 'yes' ? 'YES' : d.outcome === 'no' ? 'NO' : null;
    if (kind === 'claim') {
      if (d.why === 'refund') return { title: 'Refund ready', body: `Pool #${n} was refunded. Your stake is ready to claim on Me.`, href: '/me' };
      if (d.why === 'creator') return { title: 'Creator earnings ready', body: `Pool #${n} settled. Your creator earnings are ready to claim on Me.`, href: '/me' };
      if (d.why === 'won' && out) return { title: 'You won', body: `Pool #${n} settled ${out}. Your winnings are ready to claim on Me.`, href: '/me' };
      return FALLBACK;
    }
    const side = d.side === 'yes' ? 'YES' : d.side === 'no' ? 'NO' : null;
    if (!out || !side) return FALLBACK;
    return { title: 'Pool settled', body: `Pool #${n} settled ${out}. Your ${side} position did not win.`, href: `/pools/${n}` };
  }
  if (d.t === 'round') {
    const moved = d.outcome === 'up' ? 'went up' : d.outcome === 'down' ? 'went down' : null;
    if (kind === 'claim') {
      if (d.why === 'refund') {
        const reason = typeof d.reason === 'string' ? REFUND_REASON[d.reason] : undefined;
        return { title: `Round #${n} refunded`, body: `${reason ? `${reason} ` : ''}Your stake is ready to claim on Me.`, href: '/me' };
      }
      if (d.why === 'won' && moved) return { title: `You won round #${n}`, body: `${V1_ASSET.symbol} ${moved}. Your winnings are ready to claim on Me.`, href: '/me' };
      return FALLBACK;
    }
    const side = d.side === 'up' ? 'UP' : d.side === 'down' ? 'DOWN' : null;
    if (!moved || !side) return FALLBACK;
    return { title: `Round #${n} settled`, body: `${V1_ASSET.symbol} ${moved}. Your ${side} entry did not win.`, href: `/rounds/${n}` };
  }
  return FALLBACK;
}

export function render(n: NotificationView, opts: { timeZone?: string } = {}): Rendered {
  const d = obj(n.data);
  switch (n.kind) {
    case 'claim':
    case 'result':
      return poolOrRound(n.kind, d);
    case 'reply': {
      const pool = id(d.poolId);
      const count = typeof d.count === 'number' && Number.isInteger(d.count) && d.count > 0 ? d.count : 1;
      if (!pool) return FALLBACK;
      return { title: count === 1 ? 'New reply' : `${count} new replies`, body: `Someone replied to your comment on pool #${pool}.`, href: `/pools/${pool}` };
    }
    case 'closing': {
      const pool = id(d.poolId);
      const at = clock(d.closesAt, opts.timeZone);
      if (!pool || !at) return FALLBACK;
      return { title: 'Betting closes soon', body: `Betting on pool #${pool} closes at ${at}.`, href: `/pools/${pool}` };
    }
    case 'round_start': {
      const round = id(d.roundId);
      const at = clock(d.entriesCloseAt, opts.timeZone);
      if (!round || !at) return FALLBACK;
      return { title: 'Round starts soon', body: `Entries for round #${round} close at ${at}.`, href: `/rounds/${round}` };
    }
    case 'price': {
      const symbol = typeof d.symbol === 'string' && /^[A-Z0-9]{2,10}$/.test(d.symbol) ? d.symbol : null;
      const target = money(d.target);
      const dir = d.direction === 'above' ? 'above' : d.direction === 'below' ? 'below' : null;
      if (!symbol || !target || !dir) return FALLBACK;
      return { title: `${symbol} ${dir} ${target}`, body: `${symbol} traded at or ${dir} ${target} on Coinbase. This alert is now off.`, href: '/notifications' };
    }
    default:
      return FALLBACK;
  }
}
