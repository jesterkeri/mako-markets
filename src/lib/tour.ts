'use client';

import { useSyncExternalStore } from 'react';

import type { MascotMotion, MascotPose } from '@/components/Mascot';
import { CIRCLE_FAUCET_URL } from '@/lib/list-states';
import type { NavKey } from '@/lib/shell-nav';

// How to play (20a): the seven-step tour. Each step opens the page it explains (`?tour=<n>` on that page, so the
// wallet menu's `/?tour=1` and Settings' Replay start it), lights that page's tab, and says only what is true of the
// product today: rounds are not live, so their step says "coming soon"; the creator fee and refunds follow the
// Pools contract (MakoMarketsV4: 2% of the whole pool, forfeited below the minimum side ratio; a one-sided pool
// settles as a refund); gas is sponsored for email accounts up to SPONSOR_CAP_PER_USER_PER_DAY; test USDC comes from
// Circle's faucet.

export const TOUR_PARAM = 'tour';
export const TOUR_FAUCET_URL = CIRCLE_FAUCET_URL;

/// Desktop card style (DESIGN_RULES 20a): 'mako' = Mako talking in the corner (Home), 'tab' = a card under the lit
/// tab with a facts table, 'pointer' = a compact card whose arrow points at the thing on the page.
export type TourStyle = 'mako' | 'tab' | 'pointer';

export type TourStep = {
  name: string;
  route: string;
  /// The tab that lights while the step is open, or null (Home).
  tab: NavKey | null;
  style: TourStyle;
  pose: MascotPose;
  motion: MascotMotion;
  title: string;
  body: string;
  /// The shorter body the mobile card carries.
  bodyMobile: string;
  /// The facts table on 'tab' cards.
  facts?: readonly [string, string][];
  /// 'pointer' steps: the `data-tour-anchor` / `data-tour-point` key on the page, the design's gap under the anchor
  /// and the arrow's distance from the card's left edge.
  anchor?: { key: string; gap: number; gapMobile: number; caret: number };
  /// Mobile: which side Mako sits on (he faces the text) and how wide he is.
  mobile: { dir: 'row' | 'row-reverse'; width: number };
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    name: 'Home',
    route: '/',
    tab: null,
    style: 'mako',
    pose: 'mako-wave',
    motion: 'sway',
    title: 'Everything at a glance',
    body: 'Pools closing soon and market news, with 15-minute BTC rounds coming soon. Tap the Mako logo to come back here.',
    bodyMobile: 'Closing pools and market news in one place. BTC rounds are coming soon.',
    mobile: { dir: 'row', width: 120 },
  },
  {
    name: 'Rounds',
    route: '/rounds',
    tab: 'rounds',
    style: 'tab',
    pose: '14-timer',
    motion: 'tick',
    title: 'Call BTC in 15 minutes',
    body: 'Coming soon: rounds are not live yet. When they open, this tab lists them. You go UP or DOWN on BTC over 15 minutes, settled on Chainlink prices.',
    bodyMobile: 'Coming soon: 15-minute BTC rounds, UP or DOWN, settled on Chainlink prices.',
    facts: [
      ['LENGTH', '15 MIN'],
      ['STATUS', 'COMING SOON'],
      ['SETTLED BY', 'CHAINLINK'],
    ],
    mobile: { dir: 'row', width: 118 },
  },
  {
    name: 'Pools',
    route: '/pools',
    tab: 'pools',
    style: 'pointer',
    pose: 'mako-cash-pool',
    motion: 'float',
    title: 'YES or NO on anything',
    body: 'Crypto, football, NBA, forex, commodities, stocks. Filter by topic, pick YES or NO. Mako Market settles the result from its source; if only one side has bets, everyone is refunded.',
    bodyMobile: 'Crypto, football, NBA, forex, stocks. Pick YES or NO. Mako Market settles it; a one-sided pool is refunded.',
    anchor: { key: 'pools-topics', gap: 7, gapMobile: 12, caret: 83 },
    mobile: { dir: 'row-reverse', width: 164 },
  },
  {
    name: 'Create',
    route: '/pools/new',
    tab: 'pools',
    style: 'pointer',
    pose: '17-building',
    motion: 'shake',
    title: 'Host your own',
    body: 'Create pool on the Pools tab opens this form: pick the market and when it closes, then seed it with 1 USDC or more. You earn 2% of the whole pool when its smaller side is at least about 4%.',
    bodyMobile: 'Pick the market and when it closes, seed 1 USDC or more. Earn 2% of the pool when its smaller side reaches about 4%.',
    anchor: { key: 'create-form', gap: 12, gapMobile: 16, caret: 60 },
    mobile: { dir: 'row', width: 124 },
  },
  {
    name: 'Leaderboard',
    route: '/leaderboard',
    tab: 'leaderboard',
    style: 'tab',
    pose: '13-crown',
    motion: 'pulse',
    title: 'Climb the board',
    body: 'Ranked by profit on pools: winnings and refunds claimed, minus stakes. Look at the last 7 days, 30 days or all time. Top-10 badges are coming soon.',
    bodyMobile: 'Ranked by profit on pools, over 7 days, 30 days or all time. Badges are coming soon.',
    facts: [
      ['RANKED BY', 'PROFIT'],
      ['PERIODS', '7D · 30D · ALL'],
      ['TOP 10', 'BADGE · SOON'],
    ],
    mobile: { dir: 'row', width: 118 },
  },
  {
    name: 'Me',
    route: '/me',
    tab: 'me',
    style: 'tab',
    pose: '11-counting-usdc',
    motion: 'shake',
    title: 'Your bets and winnings',
    body: 'Your balance, open and settled bets, and your profit chart. Winnings and refunds wait here, or on the pool page, until you claim them.',
    bodyMobile: 'Your balance, bets and profit. Winnings wait here until you claim them.',
    facts: [
      ['SHOWS', 'OPEN · SETTLED'],
      ['CLAIM', 'WINS · REFUNDS'],
      ['ALSO', 'PROFIT CHART'],
    ],
    mobile: { dir: 'row', width: 122 },
  },
  {
    name: 'Test USDC',
    route: '/me',
    tab: 'me',
    style: 'pointer',
    pose: '12-faucet',
    motion: 'bob',
    title: 'Grab test USDC',
    body: 'Copy your address on Me and paste it into Circle’s faucet. Test USDC is free, and email accounts pay no gas, up to 10 transactions a day.',
    bodyMobile: 'Copy your address, then get free test USDC from Circle’s faucet. Email accounts pay no gas, up to 10 a day.',
    anchor: { key: 'test-usdc', gap: 20, gapMobile: 12, caret: 310 },
    mobile: { dir: 'row-reverse', width: 120 },
  },
];

export const TOUR_LENGTH = TOUR_STEPS.length;

/// The 0-based step a `?tour=` value names, or null when it names none ("1" to "7" only).
export function tourStepFromParam(raw: string | null): number | null {
  if (raw === null || !/^[1-9]$/.test(raw)) return null;
  const n = Number(raw);
  return n <= TOUR_LENGTH ? n - 1 : null;
}

/// The page that opens step `index` (0-based), with the tour on it.
export function tourHref(index: number): string {
  return `${TOUR_STEPS[index].route}?${TOUR_PARAM}=${index + 1}`;
}

/// The design hides the mobile tab bar on Home (the card sits low) and on the create form (a full-screen form).
export function tabBarHidden(index: number | null): boolean {
  return index === 0 || index === 3;
}

/// "STEP 4 OF 7 · CREATE · IN POOLS": the desktop card's label.
export function tourLabelDesktop(index: number): string {
  const s = TOUR_STEPS[index];
  const head = `STEP ${index + 1} OF ${TOUR_LENGTH} · ${s.name.toUpperCase()}`;
  if (!s.tab) return head;
  return s.name.toLowerCase() === s.tab ? `${head} TAB` : `${head} · IN ${s.tab.toUpperCase()}`;
}

/// "Step 4 of 7 · Create": the mobile card's label.
export function tourLabelMobile(index: number): string {
  return `Step ${index + 1} of ${TOUR_LENGTH} · ${TOUR_STEPS[index].name}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The open step, for the chrome around the page (the lit desktop tab, the hidden mobile tab bar). The tour reads the
// URL inside a Suspense boundary and publishes here, so the header and tab bar need no boundary of their own.

let current: number | null = null;
const listeners = new Set<() => void>();

export function publishTourStep(step: number | null) {
  if (current === step) return;
  current = step;
  for (const l of listeners) l();
}

export function useTourStep(): number | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
