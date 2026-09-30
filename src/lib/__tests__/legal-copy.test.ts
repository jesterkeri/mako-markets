// Terms, privacy and risk (23a): every string the page can show is held to the shipped-copy rules, and the numbers
// in the text are tied to the constants the app enforces.

import { describe, expect, it } from 'vitest';

import { MIN_CREATOR_SEED_USDC_BASE, SPONSOR_CAP_PER_USER_PER_DAY } from '../aa-constants';
import { computeMinLiquidityRatioBps } from '../bet';
import {
  allLegalStrings,
  LEGAL_DOCS,
  LEGAL_TABS,
  LEGAL_UPDATED_ISO,
  legalHref,
  legalUpdatedLabel,
  parseLegalTab,
} from '../legal-copy';

const ALL = allLegalStrings();
const body = (tab: keyof typeof LEGAL_DOCS) => LEGAL_DOCS[tab].sections.map((s) => `${s.h} ${s.p}`).join(' ');

describe('legal copy rules', () => {
  it('covers every label, title, note, heading and paragraph of all three tabs', () => {
    const expected = 2 + LEGAL_TABS.reduce((n, t) => n + 4 + LEGAL_DOCS[t].sections.length * 2, 0);
    expect(ALL).toHaveLength(expected);
    for (const t of ALL) expect(t.trim().length).toBeGreaterThan(0);
  });

  it.each(ALL.map((t) => [t]))('has no em-dash or en-dash: %s', (t) => {
    expect(t).not.toMatch(/[—–]/);
    expect(t).not.toMatch(/--/);
  });

  it.each(ALL.map((t) => [t]))('never says we / our / us / team: %s', (t) => {
    expect(t).not.toMatch(/\b(we|our|ours|us|team)\b/i);
  });

  it.each(ALL.map((t) => [t]))('keeps the brand singular: %s', (t) => {
    expect(t).not.toMatch(/Mako\s+Markets/i);
  });

  it('the scanner itself catches each banned form', () => {
    expect('We’ll tell you').toMatch(/\b(we|our|ours|us|team)\b/i);
    expect('Ask us').toMatch(/\b(we|our|ours|us|team)\b/i);
    expect('a — b').toMatch(/[—–]/);
    expect('Mako Markets').toMatch(/Mako\s+Markets/i);
    expect('USDC and status').not.toMatch(/\b(we|our|ours|us|team)\b/i);
  });
});

describe('legal copy makes no promise the product cannot keep', () => {
  const text = ALL.join(' ');

  it('never says refunds are automatic, only that they are claimed', () => {
    expect(text).not.toMatch(/refunded automatically|returned automatically|automatic refund|went back automatically/i);
    expect(body('terms')).toMatch(/not paid out automatically: you claim your full stake back, with no fee/);
    expect(body('terms')).toMatch(/24 hours after its close time, anyone can mark it refunded/);
  });

  it('names data providers, never an "official" source, and no Chainlink (Rounds are not live)', () => {
    expect(text).not.toMatch(/official/i);
    expect(text).not.toMatch(/chainlink/i);
    for (const p of ['football-data.org', 'balldontlie', 'CoinGecko', 'Pyth']) expect(body('terms')).toContain(p);
  });

  it('does not describe Rounds as available', () => {
    expect(text).not.toMatch(/15-minute|every few minutes/i);
    expect(body('terms')).toMatch(/Rounds are coming and are not live yet/);
  });

  it('states the pool creator fee as 2% of the whole pool, never of the smaller side', () => {
    expect(text).not.toMatch(/2% (creator fee )?(of|on) the smaller side/i);
    expect(body('terms')).toMatch(/1% of the whole pool/);
    expect(body('terms')).toMatch(/2% of the whole pool/);
    // "about 4%" is the contract's forfeit threshold for a 2% creator fee: 408 bps.
    expect(computeMinLiquidityRatioBps(200n)).toBe(408n);
    expect(Math.round(Number(computeMinLiquidityRatioBps(200n)) / 100)).toBe(4);
    expect(body('terms')).toMatch(/under about 4% of the larger side/);
  });

  it('ties the gas and creator-seed numbers to the constants the app enforces', () => {
    expect(body('terms')).toContain(`for up to ${SPONSOR_CAP_PER_USER_PER_DAY} of these a day`);
    expect(SPONSOR_CAP_PER_USER_PER_DAY).toBe(10);
    expect(body('terms')).toContain(`at least ${Number(MIN_CREATOR_SEED_USDC_BASE / 1_000_000n)} USDC`);
    expect(body('terms')).toMatch(/Wallet accounts pay their own gas/);
  });

  it('offers no feature that does not exist: no notifications, no deletion on request, no contact that is not real', () => {
    expect(text).not.toMatch(/notification/i);
    expect(text).not.toMatch(/ask .* to delete|delete your account and/i);
    expect(text).not.toMatch(/@|mailto|support/i);
    expect(body('privacy')).toMatch(/deleting your account are not available yet/);
  });

  it('does not promise to tell anyone about changes', () => {
    expect(body('terms')).toMatch(/The date at the top shows when they last changed\./);
    expect(text).not.toMatch(/tell you in the app|notify/i);
  });
});

describe('legal page helpers', () => {
  it('is dated 30 Sep 2026 on both layouts', () => {
    expect(LEGAL_UPDATED_ISO).toBe('2026-09-30');
    expect(legalUpdatedLabel('desk')).toBe('LAST UPDATED 30 SEP 2026');
    expect(legalUpdatedLabel('mob')).toBe('Updated 30 Sep 2026');
    expect(() => legalUpdatedLabel('desk', '2026-13-01')).toThrow();
  });

  it('opens the asked-for tab, and Terms for anything else', () => {
    expect(parseLegalTab('privacy')).toBe('privacy');
    expect(parseLegalTab('risk')).toBe('risk');
    expect(parseLegalTab(' Risk ')).toBe('risk');
    expect(parseLegalTab(['privacy', 'risk'])).toBe('privacy');
    expect(parseLegalTab(undefined)).toBe('terms');
    expect(parseLegalTab('')).toBe('terms');
    expect(parseLegalTab('cookies')).toBe('terms');
    expect(parseLegalTab([])).toBe('terms');
  });

  it('links each tab by its query value', () => {
    expect(LEGAL_TABS.map(legalHref)).toEqual(['/legal?tab=terms', '/legal?tab=privacy', '/legal?tab=risk']);
  });

  it('gives each tab its design labels, a note and unique section headings', () => {
    expect(LEGAL_TABS.map((t) => [LEGAL_DOCS[t].labelDesk, LEGAL_DOCS[t].labelMob, LEGAL_DOCS[t].title])).toEqual([
      ['TERMS', 'Terms', 'Terms of use'],
      ['PRIVACY', 'Privacy', 'Privacy'],
      ['RISK NOTICE', 'Risk', 'Risk notice'],
    ]);
    for (const t of LEGAL_TABS) {
      const hs = LEGAL_DOCS[t].sections.map((s) => s.h);
      expect(hs.length).toBeGreaterThanOrEqual(3);
      expect(new Set(hs).size).toBe(hs.length);
    }
  });
});
