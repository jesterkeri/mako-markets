// The share cards drawn with ImageResponse (Satori): docs/pnl-share-card/placed.html, win.html and loss.html rebuilt in the CSS
// Satori supports (flex, absolute positioning, no ::before/::after, no grid, no color-mix). 1600 x 900.
//
// Fonts and art are read from local files on first use and kept for the life of the server instance, never fetched
// over the network (assets/pnl-card, all OFL):
//  - Bricolage Grotesque 800 as three static TTF instances of google/fonts' variable font
//    (ofl/bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf at b9f6c71, sha256 413e7357…ac682), cut with
//    `fonttools varLib.instancer … opsz=<N> wght=800 wdth=100 --static`. The design's browser picks the optical size
//    from the font size (opsz 12 to 96); Satori cannot, so: opsz 96 for the 186px return, 60 for the question, 32 for
//    the 28 to 36px text. @fontsource's static Bricolage is cut at opsz 12, visibly wider than the approved renders.
//  - Inter 500 / 700 and JetBrains Mono 700, latin, static WOFF from @fontsource 5.3.0.
// The art and the win and loss QR tile come from public/share; the bet placed card's QR is the pool's own (pool-qr.ts).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';

import { questionPx, type PlacedCard, type ShareCard } from './pnl-card';
import type { InviteCard } from './pool-invite';
import { catTitle } from './pool-list';

export const CARD_SIZE = { width: 1600, height: 900 };

export type CardWho = {
  /// "@name", or the short address when the account has no name.
  handle: string;
  /// The letter on the yellow fallback avatar.
  initial: string;
  /// The profile photo as a data URL, or null for the letter.
  photo: string | null;
};

type Assets = { fonts: NonNullable<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>['fonts']>; win: string; loss: string; placed: string; qr: string };

let assets: Promise<Assets> | null = null;

function loadAssets(): Promise<Assets> {
  const dir = join(process.cwd(), 'assets', 'pnl-card');
  const pub = join(process.cwd(), 'public', 'share');
  const font = (f: string) => readFile(join(dir, f));
  const png = async (f: string) => `data:image/png;base64,${(await readFile(join(pub, f))).toString('base64')}`;
  return (async () => {
    const [bric96, bric60, bric32, inter5, inter7, mono, win, loss, placed, qr] = await Promise.all([
      font('bricolage-grotesque-800-opsz96.ttf'),
      font('bricolage-grotesque-800-opsz60.ttf'),
      font('bricolage-grotesque-800-opsz32.ttf'),
      font('inter-latin-500-normal.woff'),
      font('inter-latin-700-normal.woff'),
      font('jetbrains-mono-latin-700-normal.woff'),
      png('pnl-win.png'),
      png('pnl-loss.png'),
      png('bet-placed.png'),
      png('qr-makomarket.png'),
    ]);
    return {
      fonts: [
        { name: 'Bricolage96', data: bric96, weight: 800, style: 'normal' },
        { name: 'Bricolage60', data: bric60, weight: 800, style: 'normal' },
        { name: 'Bricolage', data: bric32, weight: 800, style: 'normal' },
        { name: 'Inter', data: inter5, weight: 500, style: 'normal' },
        { name: 'Inter', data: inter7, weight: 700, style: 'normal' },
        { name: 'JetBrains', data: mono, weight: 700, style: 'normal' },
      ],
      win,
      loss,
      placed,
      qr,
    };
  })();
}

function cardAssets(): Promise<Assets> {
  // A failed read is not kept, so the next request tries again.
  assets ??= loadAssets().catch((e) => {
    assets = null;
    throw e;
  });
  return assets;
}

const CREAM = '#EDE6D6';
const MUTED = '#8a857a';
const YELLOW = '#FACC15';
const INK = '#0A0A0A';

const mono = (size: number, spacing: number): React.CSSProperties => ({ fontFamily: 'JetBrains', fontWeight: 700, fontSize: size, letterSpacing: spacing * size, textTransform: 'uppercase' });
const bric = (size: number, spacing: number, family = 'Bricolage'): React.CSSProperties => ({ fontFamily: family, fontWeight: 800, fontSize: size, letterSpacing: spacing * size });

const THEME = {
  win: { pl: '#16A34A', st: '#14B8A6', ring: 'rgba(20,184,166,.22)', sided: '#0D6B30', status: 'Called it' },
  loss: { pl: '#E53935', st: '#E53935', ring: 'rgba(229,57,53,.22)', sided: '#B71C1C', status: 'Missed it' },
  placed: { pl: '#16A34A', st: '#D946EF', ring: 'rgba(217,70,239,.22)', sided: '#0D6B30', status: 'Call live' },
};
const SIDE = { yes: '#16A34A', no: '#E53935' };

const RET = 'rgba(250,204,21,.9)';

/// Win only: the reticle over the rocket, a 130px circle with four 22px ticks outside it, and its label.
function Reticle({ ret, colour }: { ret: string; colour: string }) {
  const tick = (left: number, top: number, w: number, h: number) => <div style={{ position: 'absolute', left, top, width: w, height: h, background: RET }} />;
  return (
    <>
      <div style={{ position: 'absolute', left: 1146, top: 166, width: 200, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', ...mono(15, 0.16), lineHeight: 1.5, color: RET }}>
        <span>Target locked</span>
        <span style={{ color: colour }}>{ret}</span>
      </div>
      <div style={{ position: 'absolute', left: 1366, top: 214, width: 130, height: 130, display: 'flex' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: 130, height: 130, borderRadius: 9999, border: `2px solid ${RET}` }} />
        {tick(-24, 65, 22, 2)}
        {tick(132, 65, 22, 2)}
        {tick(65, -24, 2, 22)}
        {tick(65, 132, 2, 22)}
      </div>
    </>
  );
}


const BRACKET = 'rgba(237,230,214,.7)';
const LOGO =
  'M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z';

function Bracket({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
  const s: React.CSSProperties = { position: 'absolute', width: 56, height: 56, borderColor: BRACKET, borderStyle: 'solid', borderWidth: 0 };
  if (at[0] === 't') Object.assign(s, { top: 36, borderTopWidth: 2 });
  else Object.assign(s, { bottom: 36, borderBottomWidth: 2 });
  if (at[1] === 'l') Object.assign(s, { left: 36, borderLeftWidth: 2 });
  else Object.assign(s, { right: 36, borderRightWidth: 2 });
  return <div style={s} />;
}

/// The signed figure. As the approved markup draws it, a minus is followed by a 0.09em gap so it never touches the
/// first digit; a plus is set tight (and the return pulled left instead).
function SignedText({ sign, text, size }: { sign: string; text: string; size: number }) {
  return (
    <div style={{ display: 'flex' }}>
      {sign ? <span style={{ marginRight: sign === '-' ? 0.09 * size : 0 }}>{sign}</span> : null}
      <span>{text}</span>
    </div>
  );
}

type Stat = readonly [label: string, value: string, unit: 'USDC' | null, sided: boolean];

const stats = (card: ShareCard): Stat[] =>
  card.variant === 'placed'
    ? [
        ['Stake', card.stake, 'USDC', false],
        ...(card.est ? [['Est. payout', card.est.payout, 'USDC', false] as const] : []),
        ...(card.settles ? [['Settles', card.settles, null, false] as const] : []),
        ...target(card),
      ]
    : [['Side', card.side, null, true], ['Stake', card.stake, 'USDC', false], ['Payout', card.payout, 'USDC', false], ...target(card)];

const target = (card: ShareCard): Stat[] => (card.target ? [['Target', card.target, null, false]] : []);

const inter24: React.CSSProperties = { fontFamily: 'Inter', fontWeight: 500, fontSize: 24, color: MUTED };

/// Bet placed: the side as the headline, the estimated return under it, and what the estimate rests on. The pot moves
/// until betting closes, so the card says so; with nobody on the other side there is no estimate to show.
function MyCall({ card }: { card: PlacedCard }) {
  const pot = card.potFinal ? 'Betting has closed, so the pot is final.' : 'Estimated from the pot now. It changes until betting closes.';
  return (
    <div style={{ position: 'absolute', left: 76, top: 300, display: 'flex', flexDirection: 'column' }}>
      <span style={{ ...mono(15, 0.12), color: MUTED }}>My call</span>
      <div style={{ marginTop: 6, height: 167, display: 'flex', alignItems: 'flex-end', ...bric(card.sidePx, -0.055, 'Bricolage96'), lineHeight: 0.9, color: card.isYes ? SIDE.yes : SIDE.no }}>{card.side}</div>
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'baseline' }}>
        {card.est ? (
          <>
            <div style={{ ...bric(36, -0.02), color: card.est.ret.sign === '-' ? SIDE.no : THEME.placed.pl, display: 'flex' }}>
              <SignedText sign={card.est.ret.sign} text={card.est.ret.text} size={36} />
            </div>
            <span style={{ marginLeft: 12, ...inter24 }}>est. return if right</span>
          </>
        ) : (
          <span style={inter24}>No one is on the other side yet, so there is no estimate.</span>
        )}
      </div>
      {card.est && <span style={{ marginTop: 8, ...mono(13, 0.1), color: MUTED }}>{pot}</span>}
    </div>
  );
}

function Result({ card, colour }: { card: Exclude<ShareCard, PlacedCard>; colour: string }) {
  return (
    <div style={{ position: 'absolute', left: 76, top: 300, display: 'flex', flexDirection: 'column' }}>
      <span style={{ ...mono(15, 0.12), color: MUTED }}>Return</span>
      <div style={{ marginTop: 6, ...bric(186, -0.055, 'Bricolage96'), lineHeight: 0.9, color: colour, marginLeft: card.ret.sign === '+' ? -0.035 * 186 : 0, display: 'flex' }}>
        <SignedText sign={card.ret.sign} text={card.ret.text} size={186} />
      </div>
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'baseline' }}>
        <div style={{ ...bric(36, -0.02), color: colour, display: 'flex' }}>
          <SignedText sign={card.net.sign} text={`${card.net.text} USDC`} size={36} />
        </div>
        <span style={{ marginLeft: 12, ...inter24 }}>{card.netWord}</span>
      </div>
    </div>
  );
}

export function PnlCardView({ card, who, art, qr }: { card: ShareCard; who: CardWho; art: string; qr: string }) {
  const t = THEME[card.variant];
  const cols = stats(card);
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', background: '#000', color: CREAM, fontFamily: 'JetBrains' }}>
      {card.variant === 'placed' ? (
        // Bet placed art at "right -20px bottom 10px / 1440px auto": 1670x942 at 1440 wide is 812.24 high.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={art} width={1440} height={812.24} style={{ position: 'absolute', left: 180, top: 77.76 }} alt="" />
      ) : (
        // Win and loss art, cover anchored right bottom: 1672x941 at 1600 wide is 900.4 high, so it sits 0.4px up.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={art} width={1600} height={900.4} style={{ position: 'absolute', left: 0, top: -0.4 }} alt="" />
      )}
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1600, height: 900, backgroundImage: 'linear-gradient(90deg, rgba(0,0,0,.85) 0%, rgba(0,0,0,.4) 50%, rgba(0,0,0,0) 66%)' }} />
      <Bracket at="tl" />
      <Bracket at="tr" />
      <Bracket at="bl" />
      <Bracket at="br" />

      {/* Header */}
      <div style={{ position: 'absolute', left: 76, right: 76, top: 66, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', ...bric(32, -0.03) }}>
          <svg width={46} height={36} viewBox="-3 -3 406 316" fill={CREAM}>
            <path d={LOGO} />
          </svg>
          <span style={{ marginLeft: 12 }}>Mako Market</span>
          <span style={{ ...mono(13, 0.14), background: YELLOW, color: '#000', borderRadius: 7, padding: '5px 9px', marginLeft: 22 }}>BETA</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', ...mono(18, 0.16), color: t.st }}>
          <div style={{ width: 11, height: 11, borderRadius: 9999, background: t.st, boxShadow: `0 0 0 5px ${t.ring}`, marginRight: 10 }} />
          {t.status}
        </div>
      </div>

      {/* Category and question */}
      <div style={{ position: 'absolute', left: 76, top: 150, width: 900, display: 'flex', flexDirection: 'column' }}>
        <span style={{ ...mono(15, 0.12), color: MUTED }}>{card.category}</span>
        <div style={{ marginTop: 12, ...bric(card.questionPx, -0.04, 'Bricolage60'), lineHeight: 1, color: '#F4EFE4', display: 'block', lineClamp: 2 }}>{card.question}</div>
      </div>

      {card.variant === 'placed' ? <MyCall card={card} /> : <Result card={card} colour={t.pl} />}

      {/* Stats pill */}
      <div style={{ position: 'absolute', left: 76, top: 594, display: 'flex', alignItems: 'center', padding: '22px 52px 24px', borderRadius: 999, background: YELLOW }}>
        {cols.map(([label, value, unit, sided], i) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', paddingLeft: i === 0 ? 0 : 34, paddingRight: i === cols.length - 1 ? 0 : 34, borderLeft: i === 0 ? 'none' : '2px solid rgba(10,10,10,.28)' }}>
            <span style={{ ...mono(15, 0.12), color: INK, opacity: 0.78 }}>{label}</span>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', ...bric(36, -0.02), lineHeight: 1, color: sided ? t.sided : INK }}>
              {value}
              {unit ? <span style={{ fontFamily: 'Inter', fontWeight: 700, fontSize: 18, letterSpacing: 0, color: INK, opacity: 0.72, marginLeft: 6 }}>{unit}</span> : null}
            </div>
          </div>
        ))}
      </div>

      {card.variant === 'win' && <Reticle ret={`${card.ret.sign}${card.ret.text}`} colour={t.pl} />}

      {/* Footer */}
      <div style={{ position: 'absolute', left: 76, right: 76, bottom: 58, height: 84, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: 9999, background: YELLOW, color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', ...bric(30, 0), boxShadow: '0 0 0 3px #000, 0 0 0 5px rgba(237,230,214,.5)' }}>
            {who.photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={who.photo} width={64} height={64} style={{ objectFit: 'cover' }} alt="" />
            ) : (
              who.initial
            )}
          </div>
          <div style={{ marginLeft: 16, display: 'flex', position: 'relative' }}>
            <span style={{ ...bric(28, -0.02), lineHeight: 1, color: CREAM }}>{who.handle}</span>
            <span style={{ position: 'absolute', left: 0, top: 36, whiteSpace: 'nowrap', ...mono(14, 0.16), color: MUTED }}>{card.date}</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ width: 84, height: 84, background: CREAM, borderRadius: 14, padding: 9, display: 'flex' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} width={66} height={66} alt="" />
          </div>
          <span style={{ marginLeft: 14, color: '#000', background: YELLOW, borderRadius: 999, padding: '16px 30px', ...bric(28, -0.01) }}>makomarket.xyz</span>
        </div>
      </div>
    </div>
  );
}

/// `qr`: the bet placed card's pool QR (pool-qr.ts); null draws the site QR the win and loss cards carry.
export async function renderShareCard(card: ShareCard, who: CardWho, qr: string | null, headers?: Record<string, string>): Promise<ImageResponse> {
  const a = await cardAssets();
  return new ImageResponse(<PnlCardView card={card} who={who} art={a[card.variant]} qr={qr ?? a.qr} />, { ...CARD_SIZE, fonts: a.fonts, headers });
}

// The status pill colours are the site's CSS variables (pool-list.ts); Satori cannot read them, so their light-theme
// values from mako-brand.css and mako-shell.css.
const PILL_VARS: Record<string, string> = {
  'var(--mako-signal)': '#FACC15',
  'var(--mako-gold)': '#F59E0B',
  'var(--mako-violet)': '#8B5CF6',
  'var(--mako-yes)': '#16A34A',
  'var(--mako-no)': '#E53935',
  'var(--mako-cyan)': '#06B6D4',
  'var(--mako-on-side)': '#000000',
};
const literal = (c: string) => PILL_VARS[c] ?? c;

/// A pool link's preview (Joshua 2026-10-26: pool links get the new card design): the bet card's frame, art and footer,
/// with the invite card's facts (status, time left, each side's pays and pot). No account name or photo, so the preview
/// can be cached like any pool page.
/// A string's width in ems, over-estimated on purpose (Satori cannot measure, so the card can only shrink text early):
/// emoji 1.25, full-width scripts (CJK, kana, Hangul) and the widest Latin capitals 1, everything else 0.55
/// (Bricolage and Inter average about 0.5 on real questions).
const FULL = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{3fffd}WM@%]/u;
const ems = (s: string) => [...s].reduce((w, c) => w + (/\p{Extended_Pictographic}/u.test(c) ? 1.25 : FULL.test(c) ? 1 : 0.55), 0);
/// Lines a string takes at `px` in the 900px column; 90% of it, since words wrap whole and leave each line short.
const lines = (s: string, px: number) => Math.max(1, Math.ceil((ems(s) * px) / 810));

/// The pool card's question size: the bet card's sizes up to 80 characters, then smaller steps until the question and
/// the sub line fit above the side pill (top 594). The column's other rows (category, clock label, clock, gaps) take
/// 222px of the 444 from its top (150) to the pill, 8 kept clear; the sub line is Inter 24, about 30px a line.
export function poolQuestionPx(q: string, sub: string): number {
  const n = [...q].length;
  const room = 444 - 8 - 222 - lines(sub, 24) * 30;
  const start = n <= 80 ? questionPx(q) : 40;
  return [start, 40, 34, 30, 26, 22, 18].find((px) => px <= start && lines(q, px) * px <= room) ?? 18;
}

export function PoolCardView({ card, question, art, qr }: { card: InviteCard; question: string; art: string; qr: string }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', background: '#000', color: CREAM, fontFamily: 'JetBrains' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={art} width={1440} height={812.24} style={{ position: 'absolute', left: 180, top: 77.76 }} alt="" />
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1600, height: 900, backgroundImage: 'linear-gradient(90deg, rgba(0,0,0,.85) 0%, rgba(0,0,0,.4) 50%, rgba(0,0,0,0) 66%)' }} />
      <Bracket at="tl" />
      <Bracket at="tr" />
      <Bracket at="bl" />
      <Bracket at="br" />

      <div style={{ position: 'absolute', left: 76, right: 76, top: 66, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', ...bric(32, -0.03) }}>
          <svg width={46} height={36} viewBox="-3 -3 406 316" fill={CREAM}>
            <path d={LOGO} />
          </svg>
          <span style={{ marginLeft: 12 }}>Mako Market</span>
          <span style={{ ...mono(13, 0.14), background: YELLOW, color: '#000', borderRadius: 7, padding: '5px 9px', marginLeft: 22 }}>BETA</span>
        </div>
        <span style={{ ...mono(18, 0.14), background: literal(card.pill.colour), color: literal(card.pill.fg), borderRadius: 999, padding: '10px 20px' }}>{card.pill.label}</span>
      </div>

      {/* One column, so a long question pushes the clock down rather than being cut (adversary on ada7c9b: two pools
          that differ only at the end of a long question unfurled as the same picture). Every question the create flow
          accepts (200 bytes) fits above the side pill at poolQuestionPx, sized with the sub line; text stays in the 900px column, clear of the art. */}
      <div style={{ position: 'absolute', left: 76, top: 150, width: 900, display: 'flex', flexDirection: 'column' }}>
        <span style={{ ...mono(15, 0.12), color: MUTED }}>{`${catTitle(card.cat)} pool`}</span>
        <div style={{ marginTop: 12, ...bric(poolQuestionPx(question, card.sub), -0.04, 'Bricolage60'), lineHeight: 1, color: '#F4EFE4', display: 'block', wordBreak: 'break-word' }}>{question}</div>
        <span style={{ marginTop: 28, ...mono(15, 0.12), color: MUTED }}>{card.clock.label}</span>
        <div style={{ marginTop: 10, ...bric(120, -0.04, 'Bricolage96'), lineHeight: 0.95, color: CREAM }}>{card.clock.value}</div>
        <span style={{ marginTop: 18, ...inter24 }}>{card.sub}</span>
      </div>

      <div style={{ position: 'absolute', left: 76, top: 594, display: 'flex', alignItems: 'center', padding: '22px 52px 24px', borderRadius: 999, background: YELLOW }}>
        {card.sides.map((x, i) => (
          <div key={x.side} style={{ display: 'flex', flexDirection: 'column', paddingLeft: i === 0 ? 0 : 34, paddingRight: i === 0 ? 34 : 0, borderLeft: i === 0 ? 'none' : '2px solid rgba(10,10,10,.28)' }}>
            <span style={{ ...mono(15, 0.12), color: INK, opacity: 0.78 }}>{`${x.name} · ${x.bettors} in`}</span>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', ...bric(36, -0.02), lineHeight: 1, color: x.side === 'yes' ? THEME.win.sided : THEME.loss.sided }}>
              {x.pays ? `${x.pays}` : 'No stake yet'}
              <span style={{ fontFamily: 'Inter', fontWeight: 700, fontSize: 18, letterSpacing: 0, color: INK, opacity: 0.72, marginLeft: 8 }}>{`${x.amount} USDC`}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ position: 'absolute', left: 76, right: 76, bottom: 58, height: 84, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ ...bric(28, -0.02), lineHeight: 1, color: CREAM }}>{card.scanTitle}</span>
          {card.minLine && <span style={{ marginTop: 10, ...mono(14, 0.12), color: MUTED }}>{card.minLine}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ width: 84, height: 84, background: CREAM, borderRadius: 14, padding: 9, display: 'flex' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} width={66} height={66} alt="" />
          </div>
          <span style={{ marginLeft: 14, color: '#000', background: YELLOW, borderRadius: 999, padding: '16px 30px', ...bric(28, -0.01) }}>makomarket.xyz</span>
        </div>
      </div>
    </div>
  );
}

export async function renderPoolCard(card: InviteCard, question: string, qr: string, headers?: Record<string, string>): Promise<ImageResponse> {
  const a = await cardAssets();
  return new ImageResponse(<PoolCardView card={card} question={question} art={a.placed} qr={qr} />, { ...CARD_SIZE, fonts: a.fonts, headers });
}
