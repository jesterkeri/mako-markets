// The $100 trading competition (REFERRAL_COMPETITION_PLAN r1 + owner answers, 2026-10-23): its window, its rules and
// every word it shows. Browser-safe: the standings page, the leaderboard link and the Me card all read it.

// MERGE-TODO: placeholder. Set to the hour this reaches main, rounded UP to the next full hour UTC (owner Q1).
// END follows from it, so this is the only value to change at merge.
export const COMPETITION_START = new Date('2026-10-23T20:00:00Z');
export const COMPETITION_END = new Date(COMPETITION_START.getTime() + 14 * 24 * 60 * 60 * 1000);

/// Qualifying referrals (a friend's new account through the link, plus one bet) needed to enter.
export const REQUIRED_REFERRALS = 2;
/// Settled pools (YES or NO, refunds excluded) needed to be ranked.
export const MIN_SETTLED = 5;
/// USDC for places 1, 2 and 3.
export const PRIZES = [50, 30, 20] as const;

/// "2026-10-23 20:00": the date and hour in UTC (the copy adds "UTC").
export function fmtUtc(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export const COMPETITION_COPY = {
  title: '$100 trading competition',
  rules: [
    `Runs from ${fmtUtc(COMPETITION_START)} to ${fmtUtc(COMPETITION_END)} UTC.`,
    'To enter, invite 2 friends with your link on the Me page. A friend counts once they create a Mako Market account through your link and place a bet.',
    'Ranked by profit during the competition: winnings and refunds claimed minus stakes placed, both between the dates above. Only pools you first bet on after the start count.',
    'Claim your winnings before the end. Unclaimed winnings do not count.',
    'You need at least 5 settled pools to be ranked. Ties go to the higher win rate: settled pools won out of settled pools played. Refunded pools do not count.',
    'The top 3 share $100: $50, $30 and $20, paid after the competition ends. Mako Market reviews the winners first and may disqualify duplicate or fake accounts.',
    'Updates about every 30 minutes.',
  ],
  upcoming: `Starts ${fmtUtc(COMPETITION_START)} UTC.`,
  live: `Live until ${fmtUtc(COMPETITION_END)} UTC.`,
  final: 'Final standings, under review.',
  ranked: 'Ranked',
  unranked: 'Entered, not ranked yet',
  noneRanked: 'No one has 5 settled pools yet.',
  noneEntered: 'No one has entered yet.',
  error: "Can't load the standings right now.",
  boardLink: 'Trading competition: $100 prize. See the standings',
  card: {
    title: 'Invite friends',
    body: 'Share your link. When 2 friends create a Mako Market account with it and place a bet, you enter the $100 trading competition.',
    copy: 'Copy invite link',
    copyCode: 'Copy code',
    copied: 'Copied',
    codeHint: 'Signing up on another device? Your friend can enter this code on their Me page.',
    rules: 'Competition rules',
    entered: 'You are entered in the competition.',
    notEntered: 'Not entered yet: 2 friends who placed a bet are needed.',
    enterLabel: 'Invited by a friend? Enter their code',
    enterSubmit: 'Add',
  },
  referrerErrors: {
    invalid: 'That code is not valid',
    own: "You can't use your own code",
    already: 'Your account already has an inviter',
    too_old: 'Only accounts created after the competition started can add an inviter',
    unauthorized: 'Sign in again to add an inviter',
    rate_limited: 'Too many tries. Try again later',
    unavailable: 'Something went wrong. Try again',
  },
} as const;

export type ReferrerError = keyof typeof COMPETITION_COPY.referrerErrors;

/// The Me card's count (owner 2026-10-23): link and code write the same users.ref, so they are one count. Only the
/// friends who placed a bet count toward the REQUIRED_REFERRALS needed to enter.
export function referralProgress(joined: number, qualified: number): { joined: string; qualified: string; entered: boolean } {
  return {
    joined: `${joined} signed up with your link or code`,
    qualified: `${qualified} of them placed a bet`,
    entered: qualified >= REQUIRED_REFERRALS,
  };
}
