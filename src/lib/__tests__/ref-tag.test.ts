// Ref tags: one rule for the cookie, the sign-in routes and the database CHECK (migration 0011).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isReferralTag, parseRefTag, REF_COOKIE, referralCode, referralLink, refFromCookieHeader, refFromSearch } from '../ref-tag';

describe('parseRefTag', () => {
  it('keeps lower-case letters, digits and hyphens, 1 to 32 characters, lower-casing and trimming first', () => {
    expect(parseRefTag('post3')).toBe('post3');
    expect(parseRefTag('  Launch-Thread ')).toBe('launch-thread');
    expect(parseRefTag('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('drops everything else', () => {
    for (const bad of ['', ' ', 'a'.repeat(33), 'post_3', 'post 3', 'post3;', '<b>', 'pöst', "'; drop table users;--"]) {
      expect(parseRefTag(bad)).toBeNull();
    }
    expect(parseRefTag(undefined)).toBeNull();
    expect(parseRefTag(42)).toBeNull();
  });
});

describe('where the tag comes from', () => {
  it('reads utm_campaign first, then ref', () => {
    expect(refFromSearch('?utm_source=x&utm_campaign=post3')).toBe('post3');
    expect(refFromSearch('?ref=post4')).toBe('post4');
    expect(refFromSearch('?utm_campaign=bad_tag&ref=post4')).toBe('post4');
    expect(refFromSearch('?utm_source=x')).toBeNull();
  });

  it('reads only its own cookie, and nothing malformed', () => {
    expect(refFromCookieHeader(`a=1; ${REF_COOKIE}=post3; b=2`)).toBe('post3');
    expect(refFromCookieHeader(`x${REF_COOKIE}=post3`)).toBeNull();
    expect(refFromCookieHeader(`${REF_COOKIE}=%E0%A4%A`)).toBeNull();
    expect(refFromCookieHeader(`${REF_COOKIE}=Bad Tag`)).toBeNull();
    expect(refFromCookieHeader(null)).toBeNull();
  });
});

describe('referral tags', () => {
  const ADDR = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';

  it('is r- plus the first 30 hex of the address, lower-cased, 32 characters, and passes the ref rule', () => {
    const code = referralCode(ADDR);
    expect(code).toBe('r-bc5a58487d7949da2b76ac84afc032');
    expect(code).toHaveLength(32);
    expect(parseRefTag(code)).toBe(code);
    expect(refFromSearch(`?ref=${code}`)).toBe(code);
    expect(referralLink(ADDR)).toBe(`https://makomarket.xyz/?ref=${code}`);
    expect(refFromSearch(new URL(referralLink(ADDR)).search)).toBe(code);
  });

  it('tells a referral tag from a campaign tag', () => {
    expect(isReferralTag(referralCode(ADDR))).toBe(true);
    for (const other of [null, 'post3', 'pool-142', 'r-', 'r-launch', `r-${'a'.repeat(29)}`, `r-${'a'.repeat(31)}`, `r-${'g'.repeat(30)}`, `R-${'a'.repeat(30)}`]) {
      expect(isReferralTag(other)).toBe(false);
    }
  });
});

describe('migration 0011', () => {
  it('checks the same rule the code applies', () => {
    const sql = readFileSync(join(__dirname, '../../db/migrations/0011_users_ref.sql'), 'utf8');
    expect(sql).toContain(`CHECK ("ref" IS NULL OR "ref" ~ '^[a-z0-9-]{1,32}$')`);
    const journal = JSON.parse(readFileSync(join(__dirname, '../../db/migrations/meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 11)?.tag).toBe('0011_users_ref');
  });
});
