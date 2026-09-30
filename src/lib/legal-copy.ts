// The text of Terms, privacy and risk (23a, `/legal?tab=terms|privacy|risk`). Pure data, so one source feeds the
// desktop and mobile layouts and a test can hold every sentence to the copy rules.
//
// Every sentence says what the product does today, checked on 2026-09-30 against MakoMarketsV4 on Monad testnet
// (live values read from the deployed contract), the resolver in cf-worker/src/index.ts and this app. When the
// product changes, change the sentence it touches and LEGAL_UPDATED_ISO together. Copy rules: no em-dashes, never
// "we / our / us / team" (the brand speaks as Mako Market or to "you"), brand singular.

import { MIN_CREATOR_SEED_USDC_BASE, SPONSOR_CAP_PER_USER_PER_DAY } from './aa-constants';

export type LegalTab = 'terms' | 'privacy' | 'risk';

/// Tab order on both layouts.
export const LEGAL_TABS: readonly LegalTab[] = ['terms', 'privacy', 'risk'];

export type LegalSection = { h: string; p: string };

export type LegalDoc = {
  /// Desktop side list (mono caps).
  labelDesk: string;
  /// Mobile segmented control.
  labelMob: string;
  title: string;
  /// The one thing to know, shown before the sections.
  note: string;
  sections: readonly LegalSection[];
};

/// The day this text last changed (UTC calendar date).
export const LEGAL_UPDATED_ISO = '2026-09-30';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/// "LAST UPDATED 30 SEP 2026" on desktop, "Updated 30 Sep 2026" on mobile.
export function legalUpdatedLabel(layout: 'desk' | 'mob', iso: string = LEGAL_UPDATED_ISO): string {
  const [y, m, d] = iso.split('-').map(Number);
  const month = MONTHS[m - 1];
  if (!month || !Number.isInteger(y) || !Number.isInteger(d)) throw new Error(`legalUpdatedLabel: not a date: ${iso}`);
  return layout === 'desk' ? `LAST UPDATED ${d} ${month.toUpperCase()} ${y}` : `Updated ${d} ${month} ${y}`;
}

/// The tab a `?tab=` value asks for. Anything else (missing, repeated, unknown) opens Terms.
export function parseLegalTab(raw: string | string[] | undefined): LegalTab {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return LEGAL_TABS.find((t) => t === v) ?? 'terms';
}

export function legalHref(tab: LegalTab): string {
  return `/legal?tab=${tab}`;
}

const SEED_USDC = Number(MIN_CREATOR_SEED_USDC_BASE / 1_000_000n);

export const LEGAL_DOCS: Readonly<Record<LegalTab, LegalDoc>> = {
  terms: {
    labelDesk: 'TERMS',
    labelMob: 'Terms',
    title: 'Terms of use',
    note: 'Mako Market runs on Monad testnet. USDC here is test money with no real value.',
    sections: [
      {
        h: 'What Mako Market is',
        p: 'A prediction market. You bet test USDC on YES or NO in a pool: a question about a football match, a basketball game, a price, or a house question that Mako Market sets. Rounds are coming and are not live yet.',
      },
      {
        h: 'Your account',
        p: 'You can sign in with email or with your own wallet. Signing in with email creates a wallet for you through Privy. Keep your sign-in codes to yourself: you are responsible for what happens on your account.',
      },
      {
        h: 'Gas',
        p: `Email accounts don’t pay gas to bet, create a pool, claim winnings or refunds, or send USDC, for up to ${SPONSOR_CAP_PER_USER_PER_DAY} of these a day. The count resets at 00:00 UTC. Wallet accounts pay their own gas in MON.`,
      },
      {
        h: 'How pools settle',
        p: 'Every pool has a time when betting stops and a close time, which can be later. After the close time, Mako Market’s resolver reads the result from a data provider and records it on chain: football-data.org for football, balldontlie for basketball, CoinGecko for crypto, and Pyth for forex, commodities and stocks. Mako Market settles house pools by hand, and can settle other pools by hand too. A recorded result is final.',
      },
      {
        h: 'Refunds',
        p: 'A pool is refunded if one side has no bets when it settles. The resolver also refunds a pool whose match or game is postponed, cancelled or cannot be found. If a pool is still not settled 24 hours after its close time, anyone can mark it refunded. Refunds are not paid out automatically: you claim your full stake back, with no fee. Winnings and refunds have no claim deadline.',
      },
      {
        h: 'Fees',
        p: 'When a pool settles YES or NO, Mako Market takes 1% of the whole pool and the pool’s creator earns 2% of the whole pool. If the smaller side is under about 4% of the larger side, the creator’s 2% goes to the winners instead. House pools have no creator fee. Winners share the rest in proportion to their stakes. Refunds carry no fee. A fee change only applies to pools created after it.',
      },
      {
        h: 'Limits',
        p: `Bets start at 0.10 USDC. A wallet can bet on the same pool once every 30 seconds and put at most 10,000 USDC into it. Once a pool reaches 200 USDC, a bet that would leave one wallet holding more than 20% of it is refused. Creating a pool takes a first bet of at least ${SEED_USDC} USDC, and a wallet can create up to 10 pools a day (UTC).`,
      },
      {
        h: 'Fair play',
        p: 'Mako Market can change the 10,000 USDC, 200 USDC and 20% limits, and can block a wallet from betting or creating pools. Neither stops you claiming what you are owed.',
      },
      {
        h: 'Changes',
        p: 'Mako Market may change these terms. The date at the top shows when they last changed.',
      },
    ],
  },
  privacy: {
    labelDesk: 'PRIVACY',
    labelMob: 'Privacy',
    title: 'Privacy',
    note: 'Your email is used only to sign you in. The site never shows it to anyone else.',
    sections: [
      {
        h: 'What Mako Market keeps',
        p: 'For an email account: your email, your Privy user id and your wallet addresses. For a wallet account: your wallet address. For both: the display name and picture you choose, when you joined, your sign-in sessions, your comments, a record of each gas-free transaction, and counts that limit how often you comment and use gas-free transactions. If you turn on two-factor sign-in, its secret is stored encrypted, your recovery codes only as hashes, and wrong codes are counted so guessing gets locked out.',
      },
      {
        h: 'What is public',
        p: 'Your bets, claims and pools are on Monad testnet, where anyone can see them next to your account’s address. The leaderboard shows your display name, and your comments show your display name and picture. Your picture is stored as a public file.',
      },
      {
        h: 'Who handles it',
        p: 'Privy runs email sign-in: it sends your sign-in codes and creates your wallet. Pimlico relays gas-free transactions. Neon hosts the database. Vercel hosts the site, stores pictures and counts page views. Your browser reads the chain through Monad’s public testnet RPC. If you sign in with a wallet, your wallet app handles it, through WalletConnect if you choose that. There are no ads and no ad trackers.',
      },
      {
        h: 'In your browser',
        p: 'A sign-in cookie keeps you signed in for up to 7 days, and a short-lived one is set while you sign in with a wallet. Your browser also keeps your theme and up to 5 emails you signed in with on this device, so you can switch back quickly.',
      },
      {
        h: 'Your choices',
        p: 'You can change your display name or take your picture off your profile at any time; the uploaded file itself is not deleted yet. Deleting a comment hides it, but its text stays in the database. Changing your email and deleting your account are not available yet. Bets on chain can never be erased.',
      },
    ],
  },
  risk: {
    labelDesk: 'RISK NOTICE',
    labelMob: 'Risk',
    title: 'Risk notice',
    note: 'Predictions can lose. Only play with what you can afford to lose.',
    sections: [
      {
        h: 'You can lose your stake',
        p: 'If your side loses, your stake goes to the winners and to fees. What a win pays depends on how much is on each side, so the estimate keeps changing until betting stops.',
      },
      {
        h: 'Results come from data providers',
        p: 'A provider can be late, down or wrong, and a recorded result cannot be changed or appealed. A price pool settles on the price the resolver reads when it checks after the close time, not a price fixed at the exact close.',
      },
      {
        h: 'Prices move fast',
        p: 'A price can swing a long way in minutes. Past results don’t predict the next one.',
      },
      {
        h: 'Smart contracts and testnet',
        p: 'The contracts are new and run on testnet. Bugs are possible. Monad testnet can slow down or go offline, and while it does you cannot bet or claim.',
      },
      {
        h: 'Where you live',
        p: 'Prediction markets are restricted in some places. You are responsible for following the rules where you live.',
      },
    ],
  },
};

/// Every string the page can show, for the copy-rule test.
export function allLegalStrings(): string[] {
  const out: string[] = [legalUpdatedLabel('desk'), legalUpdatedLabel('mob')];
  for (const tab of LEGAL_TABS) {
    const d = LEGAL_DOCS[tab];
    out.push(d.labelDesk, d.labelMob, d.title, d.note);
    for (const s of d.sections) out.push(s.h, s.p);
  }
  return out;
}
