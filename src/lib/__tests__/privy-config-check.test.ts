// The Privy app settings check (INBOX_GAP_PLAN r18 [M5]): one passing configuration, then one failure per rule.
import { describe, expect, it } from 'vitest';

import { checkPrivyAppConfig, EXPECTED_DOMAINS, OTHER_LOGIN_METHODS, type PrivyAppSettings } from '@/lib/privy-config-check';

const PROD = 'cm-prod-app-id-0000000000';
const good = (over: Partial<PrivyAppSettings> = {}): PrivyAppSettings => ({
  id: PROD,
  allowed_domains: ['https://makomarket.xyz'],
  allowed_native_app_ids: [],
  allowed_native_app_url_schemes: [],
  mfa_methods: ['totp'],
  passkey_auth: false,
  passkeys_for_signup_enabled: false,
  email_auth: true,
  merge_accounts_by_email: false,
  embedded_wallet_config: { create_on_login: 'off', ethereum: { create_on_login: 'off' }, solana: { create_on_login: 'off' }, mode: 'user-controlled-server-wallets-only', user_owned_recovery_options: [] },
  ...Object.fromEntries(OTHER_LOGIN_METHODS.map((m) => [m, false])),
  ...over,
});
const fails = (s: PrivyAppSettings, role: 'production' | 'development' = 'production', mode?: string) => checkPrivyAppConfig(s, role, PROD, mode).failures;

describe('checkPrivyAppConfig', () => {
  it('passes the reviewed production configuration and records the wallet mode', () => {
    const v = checkPrivyAppConfig(good(), 'production', PROD, 'user-controlled-server-wallets-only');
    expect(v).toMatchObject({ ok: true, failures: [], recorded: { mode: 'user-controlled-server-wallets-only' } });
  });
  it('the wrong app, or a factor other than an authenticator', () => {
    expect(fails(good({ id: 'other' }))).toHaveLength(1);
    expect(fails(good({ mfa_methods: ['totp', 'sms'] }))[0]).toMatch(/exactly \[totp\]/);
    expect(fails(good({ mfa_methods: [] }))[0]).toMatch(/exactly \[totp\]/);
    expect(fails(good({ mfa_methods: ['passkey'] }))[0]).toMatch(/exactly \[totp\]/);
  });
  it('passkeys on [B1], email off, merge by email on [D3], a native app [B5]', () => {
    expect(fails(good({ passkey_auth: true }))[0]).toMatch(/passkey_auth/);
    expect(fails(good({ passkeys_for_signup_enabled: true }))[0]).toMatch(/signup/);
    expect(fails(good({ email_auth: false }))[0]).toMatch(/email login/);
    expect(fails(good({ merge_accounts_by_email: true }))[0]).toMatch(/merge/);
    expect(fails(good({ allowed_native_app_ids: ['x'] }))[0]).toMatch(/native/);
    expect(fails(good({ allowed_native_app_url_schemes: ['x'] }))[0]).toMatch(/native/);
  });
  it('every other login method must be off [C7]', () => {
    for (const m of OTHER_LOGIN_METHODS) expect(fails(good({ [m]: true }))).toEqual([expect.stringContaining(m)]);
  });
  it('a wallet at login, on any chain or at the top level [C5] [D3]', () => {
    const w = good().embedded_wallet_config;
    expect(fails(good({ embedded_wallet_config: { ...w, create_on_login: 'users-without-wallets' } }))[0]).toMatch(/create_on_login/);
    expect(fails(good({ embedded_wallet_config: { ...w, ethereum: { create_on_login: 'all-users' } } }))[0]).toMatch(/ethereum/);
    expect(fails(good({ embedded_wallet_config: { ...w, solana: { create_on_login: 'users-without-wallets' } } }))[0]).toMatch(/solana/);
  });
  it('a wallet mode other than the one the matrix was proven on', () => {
    expect(fails(good(), 'production', 'some-other-mode')[0]).toMatch(/mode/);
  });
  it('domains: exactly the reviewed list per app, no wildcard, never empty, no test domain on production', () => {
    expect(fails(good({ allowed_domains: ['https://makomarket.xyz', 'http://localhost:3001'] }))[0]).toMatch(/exactly/);
    expect(fails(good({ allowed_domains: [] }))).toEqual(expect.arrayContaining([expect.stringMatching(/empty/)]));
    expect(fails(good({ allowed_domains: ['https://*.makomarket.xyz'] }))).toEqual(expect.arrayContaining([expect.stringMatching(/wildcard/)]));
    expect(fails(good({ allowed_domains: [...EXPECTED_DOMAINS.development] }), 'development')).toEqual([]);
    expect(fails(good({ allowed_domains: ['https://makomarket.xyz'] }), 'development')[0]).toMatch(/exactly/);
  });
  it('an unlisted *_oauth or *_auth flag, WhatsApp, Telegram seamless or external wallets at signup fails closed', () => {
    expect(fails(good({ newprovider_oauth: true }))[0]).toMatch(/newprovider_oauth/);
    expect(fails(good({ whatsapp_enabled: true }))[0]).toMatch(/whatsapp/);
    expect(fails(good({ telegram_seamless_auth_enabled: true }))[0]).toMatch(/telegram_seamless/);
    expect(fails(good({ external_wallets_for_signup_enabled: true }))[0]).toMatch(/external_wallets/);
    expect(fails(good({ custom_oauth_providers: [{ enabled: false, provider: 'custom:x' }] }))).toEqual([]);
  });
});
