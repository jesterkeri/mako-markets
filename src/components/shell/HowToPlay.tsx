'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Mascot } from '@/components/Mascot';
import { prefersReducedMotion, useReducedMotion } from '@/lib/use-media-query';
import { NAV } from '@/lib/shell-nav';
import {
  publishTourStep,
  tabBarHidden,
  TOUR_FAUCET_URL,
  TOUR_LENGTH,
  TOUR_PARAM,
  TOUR_STEPS,
  tourHref,
  tourLabelDesktop,
  tourLabelMobile,
  tourStepFromParam,
  type TourStep,
} from '@/lib/tour';

// How to play (20a). The page stays exactly as it is (no blur, no spotlight); only the tour card sits on top, beside
// or under what it explains. Positions are measured on the live page (getBoundingClientRect), as DESIGN_RULES ask,
// against the elements that carry `data-tour-anchor` / `data-tour-point`, the nav links and the tab bar.

const EASE = 'cubic-bezier(0.65,0,0.35,1)';
/// The card and its arrow slide to their next place, except for someone who asked for less motion (fade only).
function useSlide(): string | undefined {
  return useReducedMotion() ? undefined : `left 650ms ${EASE}`;
}
const DESK_CARD_SHADOW = 'var(--edge), inset 0 0 0 1px var(--line), 0 0 0 5px var(--mako-canvas), 0 24px 60px rgba(0,0,0,.45)';
const MOB_CARD_SHADOW = 'var(--edge), 0 18px 40px rgba(0,0,0,.35)';
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };

type DeskPlace = { top: number; left: number; caret: number | null };
type MobPlace = { mode: 'fixed'; bottom: number; caret: number | null } | { mode: 'page'; top: number; caret: number | null };

function shown(sel: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(sel)) if (el.getClientRects().length > 0) return el;
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const navHref = (tab: TourStep['tab']) => NAV.find((n) => n.key === tab)?.href ?? '/';

/// Where the desktop card goes: under its tab (tab cards), or under its anchor with the arrow on the point (pointer
/// cards; a page without the anchor, e.g. signed out, falls back to the tab).
function placeDesktop(step: TourStep): DeskPlace {
  const width = document.documentElement.clientWidth;
  const frame = Math.max(0, (width - 1280) / 2);
  if (step.style === 'pointer' && step.anchor) {
    const anchor = shown(`.mk-desk [data-tour-anchor="${step.anchor.key}"]`);
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      const p = (shown(`.mk-desk [data-tour-point="${step.anchor.key}"]`) ?? anchor).getBoundingClientRect();
      const px = p.left + p.width / 2 + window.scrollX;
      const left = clamp(px - step.anchor.caret, frame + 16, width - 16 - 500);
      return { top: a.bottom + window.scrollY + step.anchor.gap, left, caret: clamp(px - left, 24, 476) };
    }
  }
  const link = shown(`.mk-desk nav[aria-label="Main"] a[href="${navHref(step.tab)}"]`);
  if (!link) return { top: 108, left: frame + 24, caret: null };
  const r = link.getBoundingClientRect();
  const cx = r.left + r.width / 2 + window.scrollX;
  const left = clamp(cx - 90, frame + 24, frame + 636);
  return { top: r.bottom + window.scrollY + 40, left, caret: cx - left };
}

/// Where the mobile card goes: above the tab bar with the arrow down at the lit tab (tab steps), under its anchor
/// with the arrow up (pointer steps), or low on the screen with the tab bar hidden (Home).
function placeMobile(step: TourStep, index: number): MobPlace {
  if (step.style === 'pointer' && step.anchor) {
    const anchor = shown(`.mk-mob [data-tour-anchor="${step.anchor.key}"]`);
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      const p = (shown(`.mk-mob [data-tour-point="${step.anchor.key}"]`) ?? anchor).getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      return { mode: 'page', top: a.bottom + window.scrollY + step.anchor.gapMobile, caret: clamp(p.left + p.width / 2 - 12, 28, width - 24 - 28) };
    }
  }
  if (tabBarHidden(index)) return { mode: 'fixed', bottom: 60, caret: null };
  const link = step.tab ? shown(`.mk-mob nav[aria-label="Main"] a[href="${navHref(step.tab)}"]`) : null;
  if (!link) return { mode: 'fixed', bottom: 90, caret: null };
  const r = link.getBoundingClientRect();
  return { mode: 'fixed', bottom: 90, caret: r.left + r.width / 2 - 12 };
}

export function HowToPlay() {
  const params = useSearchParams();
  const index = tourStepFromParam(params.get(TOUR_PARAM));
  useEffect(() => {
    publishTourStep(index);
  }, [index]);
  useEffect(() => () => publishTourStep(null), []);
  return index === null ? null : <Tour index={index} />;
}

function Tour({ index }: { index: number }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const params = useSearchParams();
  const step = TOUR_STEPS[index];
  const last = index === TOUR_LENGTH - 1;
  const [desk, setDesk] = useState<DeskPlace | null>(null);
  const [mob, setMob] = useState<MobPlace | null>(null);
  const deskNext = useRef<HTMLElement>(null);
  const mobNext = useRef<HTMLElement>(null);
  const scrolled = useRef<number | null>(null);

  const close = useCallback(() => {
    const rest = new URLSearchParams(params.toString());
    rest.delete(TOUR_PARAM);
    const qs = rest.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);
  const go = (i: number) => router.push(tourHref(i));
  const skip = () => (last ? close() : go(TOUR_LENGTH - 1));

  useEffect(() => {
    const measure = () => {
      const isDesk = window.matchMedia('(min-width: 1024px)').matches;
      if (isDesk) {
        const next = placeDesktop(step);
        setDesk((prev) => (prev && prev.top === next.top && prev.left === next.left && prev.caret === next.caret ? prev : next));
      } else {
        const next = placeMobile(step, index);
        setMob((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      }
      // A pointer card's target below the fold is brought into view once per step.
      if (step.style === 'pointer' && step.anchor && scrolled.current !== index) {
        const anchor = shown(`${isDesk ? '.mk-desk' : '.mk-mob'} [data-tour-anchor="${step.anchor.key}"]`);
        if (anchor) {
          scrolled.current = index;
          const r = anchor.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight - 280) window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 120), behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
        }
      }
    };
    measure();
    const t = setInterval(measure, 250);
    window.addEventListener('resize', measure);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', measure);
    };
  }, [step, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    (window.matchMedia('(min-width: 1024px)').matches ? deskNext : mobNext).current?.focus({ preventScroll: true });
  }, [index]);

  const actions: Actions = { index, last, back: () => go(index - 1), next: () => (last ? close() : go(index + 1)), skip, close };
  return (
    <>
      <div className="mk-desk">
        <DesktopCard step={step} place={desk} actions={actions} nextRef={deskNext} />
      </div>
      <div className="mk-mob mk-m">
        <MobileCard step={step} place={mob} actions={actions} nextRef={mobNext} />
      </div>
    </>
  );
}

type Actions = { index: number; last: boolean; back: () => void; next: () => void; skip: () => void; close: () => void };

/// Next, or on the last step the faucet itself (a new tab) which also ends the tour.
function NextButton({ actions, style, className, nextRef }: { actions: Actions; style: React.CSSProperties; className?: string; nextRef: React.RefObject<HTMLElement | null> }) {
  if (actions.last) {
    return (
      <a ref={nextRef as React.RefObject<HTMLAnchorElement>} href={TOUR_FAUCET_URL} target="_blank" rel="noopener noreferrer" onClick={actions.close} className={className} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>
        Get test USDC ↗
      </a>
    );
  }
  return (
    <button ref={nextRef as React.RefObject<HTMLButtonElement>} type="button" onClick={actions.next} className={className} style={style}>
      Next
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Desktop: canvas-coloured card, hairline, page-coloured ring; Mako on the card's own colour.

function DeskBars({ index }: { index: number }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {TOUR_STEPS.map((s, i) => (
        <div key={s.name} style={{ flex: 1, height: 5, borderRadius: 9999, background: i <= index ? 'var(--mako-canvas-fg)' : 'var(--raise2)' }} />
      ))}
    </div>
  );
}

function DeskHead({ index, skip }: { index: number; skip: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', letterSpacing: '.08em' }}>{tourLabelDesktop(index)}</span>
      <button type="button" onClick={skip} style={{ flex: 'none', height: 28, padding: '0 12px', borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)', ...mono, fontSize: 11, fontWeight: 700, color: 'var(--dim)' }}>
        SKIP
      </button>
    </div>
  );
}

function DeskButtons({ actions, height, nextRef }: { actions: Actions; height: number; nextRef: React.RefObject<HTMLElement | null> }) {
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
      {actions.index > 0 && (
        <button type="button" onClick={actions.back} className="mk-press97" style={{ flex: 'none', width: 100, height, borderRadius: 9999, background: 'var(--raise2)', ...display, fontSize: 15 }}>
          Back
        </button>
      )}
      <NextButton actions={actions} nextRef={nextRef} className="mk-press97" style={{ flex: 1, height, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: 15 }} />
    </div>
  );
}

function YellowCaret({ left }: { left: number }) {
  const slide = useSlide();
  return (
    <span
      aria-hidden="true"
      style={{ position: 'absolute', top: -9, left, width: 0, height: 0, marginLeft: -9, borderLeft: '9px solid transparent', borderRight: '9px solid transparent', borderBottom: '10px solid var(--mako-signal)', transition: slide }}
    />
  );
}

function DesktopCard({ step, place, actions, nextRef }: { step: TourStep; place: DeskPlace | null; actions: Actions; nextRef: React.RefObject<HTMLElement | null> }) {
  const slide = useSlide();
  const frameRight = 'max(0px, (100vw - 1280px) / 2)';
  if (step.style === 'mako') {
    return (
      <>
        <div aria-hidden="true" style={{ position: 'fixed', right: `calc(${frameRight} + 36px)`, bottom: 24, zIndex: 45, pointerEvents: 'none' }}>
          <Mascot pose={step.pose} motion={step.motion} alt="" style={{ display: 'block', height: 300, width: 'auto' }} />
        </div>
        <div role="dialog" aria-label="How to play" className="wl-dlg mk-pop" style={{ position: 'fixed', zIndex: 45, boxSizing: 'border-box', borderRadius: 16, background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)', boxShadow: DESK_CARD_SHADOW, right: `calc(${frameRight} + 330px)`, bottom: 150, width: 430, padding: '20px 22px 22px' }}>
          <span aria-hidden="true" style={{ position: 'absolute', right: -7, bottom: 46, width: 12, height: 12, background: 'var(--mako-canvas)', boxShadow: 'inset -1px 1px 0 var(--line)', transform: 'rotate(45deg)' }} />
          <DeskHead index={actions.index} skip={actions.skip} />
          <div style={{ ...display, fontSize: 30, lineHeight: 1.05, letterSpacing: '-0.03em', marginTop: 12 }}>{step.title}</div>
          <div style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--dim)', marginTop: 8 }}>{step.body}</div>
          <div style={{ marginTop: 16 }}>
            <DeskBars index={actions.index} />
          </div>
          <DeskButtons actions={actions} height={44} nextRef={nextRef} />
        </div>
      </>
    );
  }
  if (!place) return null;
  if (step.style === 'tab') {
    return (
      <div
        role="dialog"
        aria-label="How to play"
        className="wl-dlg mk-pop"
        style={{ position: 'absolute', top: place.top, left: place.left, width: 620, boxSizing: 'border-box', zIndex: 45, borderRadius: 16, background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)', boxShadow: DESK_CARD_SHADOW, display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', transition: slide }}
      >
        {place.caret !== null && <YellowCaret left={place.caret} />}
        <div style={{ position: 'relative', margin: '8px 0 0 8px', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', minHeight: 300 }}>
          <Mascot pose={step.pose} motion={step.motion} alt="" style={{ position: 'relative', height: 230, width: 'auto', marginBottom: -4 }} />
        </div>
        <div style={{ padding: 18, paddingLeft: 20, paddingRight: 20, display: 'flex', flexDirection: 'column' }}>
          <DeskHead index={actions.index} skip={actions.skip} />
          <div style={{ ...display, fontSize: 28, lineHeight: 1.05, letterSpacing: '-0.03em', marginTop: 10 }}>{step.title}</div>
          <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--dim)', marginTop: 8 }}>{step.body}</div>
          {step.facts && (
            <div style={{ marginTop: 10, boxShadow: 'inset 0 1px 0 var(--line)' }}>
              {step.facts.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '8px 0', boxShadow: 'inset 0 -1px 0 var(--line)', ...mono, fontSize: 12 }}>
                  <span style={{ color: 'var(--dim)', letterSpacing: '.06em' }}>{k}</span>
                  <span style={{ fontWeight: 700 }}>{v}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 'auto', paddingTop: 14 }}>
            <DeskBars index={actions.index} />
          </div>
          <DeskButtons actions={actions} height={44} nextRef={nextRef} />
        </div>
      </div>
    );
  }
  return (
    <div
      role="dialog"
      aria-label="How to play"
      className="wl-dlg mk-pop"
      style={{ position: 'absolute', top: place.top, left: place.left, width: 500, boxSizing: 'border-box', zIndex: 45, borderRadius: 16, background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)', boxShadow: DESK_CARD_SHADOW, padding: 14, display: 'grid', gridTemplateColumns: '120px minmax(0,1fr)', gap: 16 }}
    >
      {place.caret !== null && <YellowCaret left={place.caret} />}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', minHeight: 170 }}>
        <Mascot pose={step.pose} motion={step.motion} alt="" style={{ position: 'relative', maxHeight: 160, maxWidth: '100%', width: 'auto', height: 'auto', marginBottom: -2 }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', padding: '4px 4px 2px 0' }}>
        <DeskHead index={actions.index} skip={actions.skip} />
        <div style={{ ...display, fontSize: 24, lineHeight: 1.05, letterSpacing: '-0.03em', marginTop: 8 }}>{step.title}</div>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--dim)', marginTop: 6 }}>{step.body}</div>
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <DeskBars index={actions.index} />
        </div>
        <DeskButtons actions={actions} height={40} nextRef={nextRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mobile: cream on dark / black on light, no border or ring; Mako inside the card beside the text, facing it.

function MobileCard({ step, place, actions, nextRef }: { step: TourStep; place: MobPlace | null; actions: Actions; nextRef: React.RefObject<HTMLElement | null> }) {
  const slide = useSlide();
  if (!place) return null;
  const tint = 'color-mix(in srgb, var(--m3-inv-fg) 12%, transparent)';
  const pos: React.CSSProperties = place.mode === 'fixed' ? { position: 'fixed', bottom: `calc(${place.bottom}px + env(safe-area-inset-bottom))` } : { position: 'absolute', top: place.top };
  return (
    <div role="dialog" aria-label="How to play" className="mk-pop" style={{ ...pos, left: 12, right: 12, zIndex: 45, boxSizing: 'border-box', borderRadius: 28, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: MOB_CARD_SHADOW, padding: '14px 16px' }}>
      {place.caret !== null && place.mode === 'fixed' && (
        <span aria-hidden="true" style={{ position: 'absolute', bottom: -9, left: place.caret, width: 0, height: 0, marginLeft: -9, borderLeft: '9px solid transparent', borderRight: '9px solid transparent', borderTop: '10px solid var(--m3-inv)', transition: slide }} />
      )}
      {place.caret !== null && place.mode === 'page' && (
        <span aria-hidden="true" style={{ position: 'absolute', top: -9, left: place.caret, width: 0, height: 0, marginLeft: -9, borderLeft: '9px solid transparent', borderRight: '9px solid transparent', borderBottom: '10px solid var(--m3-inv)' }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 700, opacity: 0.65 }}>{tourLabelMobile(actions.index)}</span>
        <button type="button" onClick={actions.skip} className="m3-press" style={{ height: 30, padding: '0 12px', borderRadius: 9999, background: tint, color: 'inherit', fontSize: 13, fontWeight: 800 }}>
          Skip
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: step.mobile.dir, gap: 12, alignItems: 'flex-end', marginTop: 6 }}>
        <div aria-hidden="true" style={{ flex: 'none', width: step.mobile.width, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', marginBottom: -4 }}>
          <Mascot pose={step.pose} motion={step.motion} alt="" style={{ display: 'block', width: '100%', height: 'auto' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0, alignSelf: 'center', display: 'flex', flexDirection: 'column', padding: '6px 0' }}>
          <div style={{ ...display, fontSize: 23, lineHeight: 1.05, letterSpacing: '-0.03em' }}>{step.title}</div>
          <div style={{ fontSize: 15, lineHeight: 1.45, opacity: 0.75, marginTop: 6 }}>{step.bodyMobile}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
        {TOUR_STEPS.map((s, i) => (
          <div key={s.name} style={{ flex: 1, height: 5, borderRadius: 9999, background: i <= actions.index ? 'var(--m3-inv-fg)' : 'color-mix(in srgb, var(--m3-inv-fg) 20%, transparent)' }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        {actions.index > 0 && (
          <button type="button" onClick={actions.back} className="m3-press" style={{ flex: 'none', width: 100, height: 50, borderRadius: 9999, background: tint, color: 'inherit', fontSize: 16, fontWeight: 800 }}>
            Back
          </button>
        )}
        <NextButton actions={actions} nextRef={nextRef} className="m3-press m3-scale96" style={{ flex: 1, height: 50, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16, fontWeight: 800 }} />
      </div>
    </div>
  );
}
