// Copy for the shared empty and error states (16a) of the three main lists. Lifted from the design, corrected
// where the design promises something the product does not do today (the contract wins):
//  - Rounds do not "run every few minutes": one exists only when a creator schedules it.
//  - Test USDC comes from Circle's faucet (a link out), not from Mako, so no amount is promised.
//  - Reminders need notifications, which are not built yet: "Remind me" shows as coming soon.

import type { MascotMotion, MascotPose } from '@/components/Mascot';

export type ListKind = 'rounds' | 'pools' | 'me';

export type ListAction =
  | { label: string; href: string; external?: boolean }
  | { label: string; retry: true }
  | { label: string; comingSoon: true };

export type ListStateCopy = {
  title: string;
  body: string;
  pose: MascotPose;
  motion: MascotMotion;
  primary: ListAction;
  secondary: ListAction;
  footer?: string;
};

export const CIRCLE_FAUCET_URL = 'https://faucet.circle.com/';

const EMPTY: Record<ListKind, ListStateCopy> = {
  rounds: {
    title: 'No rounds scheduled right now',
    body: 'A round opens for entries the moment a creator schedules it, 10 minutes to 7 days ahead.',
    pose: 'mako-sleeping',
    motion: 'breathe',
    primary: { label: 'Browse pools', href: '/pools' },
    secondary: { label: 'Remind me', comingSoon: true },
  },
  pools: {
    title: 'No pools open right now',
    body: 'Pools open when a creator makes one.',
    pose: '16-search-magnifying-glass',
    motion: 'pan',
    primary: { label: 'Go to Rounds', href: '/rounds' },
    secondary: { label: 'Create pool market', href: '/pools/new' },
  },
  me: {
    title: 'No bets yet',
    body: 'Your rounds and pools show up here, with anything you can claim. Start with test USDC from Circle’s faucet.',
    pose: '12-faucet',
    motion: 'bob',
    primary: { label: 'Get test USDC', href: CIRCLE_FAUCET_URL, external: true },
    secondary: { label: 'Go to Rounds', href: '/rounds' },
  },
};

const ERROR_BODY: Record<ListKind, [string, string]> = {
  rounds: ['Can’t load rounds right now', 'Mako Market couldn’t reach Monad. Your bets are safe on-chain and nothing was lost.'],
  pools: ['Can’t load pools right now', 'Mako Market couldn’t reach Monad. Your bets are safe on-chain and nothing was lost.'],
  me: ['Can’t load your positions', 'Your balance and winnings are safe on-chain. Mako Market just couldn’t read them right now.'],
};

/// The empty or error copy for a list. `explorerHref` is the account's explorer page, offered on Me's error.
export function listStateCopy(kind: ListKind, state: 'empty' | 'error', explorerHref?: string): ListStateCopy {
  if (state === 'empty') return EMPTY[kind];
  const [title, body] = ERROR_BODY[kind];
  return {
    title,
    body,
    pose: '20-error-cable',
    motion: 'glitch',
    primary: { label: 'Try again', retry: true },
    secondary:
      kind === 'me' && explorerHref
        ? { label: 'View on explorer', href: explorerHref, external: true }
        : { label: 'Go home', href: '/' },
    footer: 'Error code hidden. If this keeps happening, check your connection.',
  };
}
