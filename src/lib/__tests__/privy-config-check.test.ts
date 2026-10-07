// The Privy app settings check (INBOX_GAP_PLAN r18 [M5]): one passing configuration, then one failure per rule.
import { describe, expect, it } from 'vitest';

import {
  checkPrivyAppConfig,
  EXPECTED_DOMAINS,
  EXPECTED_WALLET_MODE,
  OTHER_LOGIN_METHODS,
  OTHER_SIGNUP_FLAGS,
  runPrivyConfigCheck,
  type PrivyAppSettings,
} from '@/lib/privy-config-check';

const PROD = 'cm-prod-app-id-0000000000';
const MODE = 'user-controlled-server-wallets-only';
const good = (over: Partial<PrivyAppSettings> & Record<string, unknown> = {}): PrivyAppSettings => ({
  id: PROD,
  allowed_domains: ['https://makomarket.xyz'],
  allowed_native_app_ids: [],
  allowed_native_app_url_schemes: [],
  mfa_methods: ['totp'],
  passkey_auth: false,
  passkeys_for_signup_enabled: false,
  email_auth: true,
  merge_accounts_by_email: false,
  custom_oauth_providers: [],
  max_linked_wallets_per_user: null,
  embedded_wallet_config: { create_on_login: 'off', ethereum: { create_on_login: 'off' }, solana: { create_on_login: 'off' }, mode: MODE, user_owned_recovery_options: [] },
  ...Object.fromEntries(OTHER_LOGIN_METHODS.map((m) => [m, false])),
  ...Object.fromEntries(OTHER_SIGNUP_FLAGS.map((m) => [m, false])),
  telegram_seamless_auth_enabled: false,
  ...over,
});
const fails = (s: unknown, role: 'production' | 'development' = 'production', mode: string | null = MODE) => checkPrivyAppConfig(s, role, PROD, mode).failures;
const without = (path: string): Record<string, unknown> => {
  const s = structuredClone(good()) as Record<string, unknown>;
  const [a, b] = path.split('.');
  if (b) delete (s[a] as Record<string, unknown>)[b];
  else delete s[a];
  return s;
};

describe('checkPrivyAppConfig', () => {
  it('passes the reviewed production configuration and records the wallet mode', () => {
    const v = checkPrivyAppConfig(good(), 'production', PROD, MODE);
    expect(v).toMatchObject({ ok: true, failures: [], recorded: { mode: MODE, telegram_seamless_auth_enabled: false, telegram_auth_config_seamless: 'absent' } });
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
  it('a wallet mode other than the one the matrix was proven on, and a mode not pinned yet, both fail (Codex gates F1)', () => {
    expect(fails(good(), 'production', 'legacy-embedded-wallets-only')[0]).toMatch(/mode is user-controlled-server-wallets-only, expected legacy/);
    expect(fails(good(), 'development', 'legacy-embedded-wallets-only')[0]).toMatch(/expected legacy/);
    expect(fails(good(), 'production', null)).toEqual([expect.stringMatching(/not pinned yet: this app runs user-controlled-server-wallets-only/)]);
  });
  it('a security field that is absent or of the wrong type fails; it is never read as off (Codex gates F3)', () => {
    const groups = [
      'id', 'allowed_domains', 'allowed_native_app_ids', 'allowed_native_app_url_schemes', 'mfa_methods',
      'passkey_auth', 'passkeys_for_signup_enabled', 'email_auth', 'merge_accounts_by_email', 'custom_oauth_providers',
      'max_linked_wallets_per_user', 'embedded_wallet_config', 'embedded_wallet_config.mode',
      'embedded_wallet_config.create_on_login', 'embedded_wallet_config.ethereum', 'embedded_wallet_config.solana',
      'embedded_wallet_config.user_owned_recovery_options', ...OTHER_LOGIN_METHODS, ...OTHER_SIGNUP_FLAGS,
    ];
    for (const g of groups) expect(fails(without(g)), g).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${g.replace('.', '\\.')} is missing or malformed`))]));
    expect(fails(good({ passkey_auth: 'false' as unknown as boolean }))[0]).toMatch(/^passkey_auth is missing or malformed/);
    expect(fails(good({ custom_oauth_providers: [{ provider: 'custom:x' }] as never }))[0]).toMatch(/^custom_oauth_providers\.0\.enabled is missing/);
    expect(fails(null)[0]).toMatch(/missing or malformed/);
  });
  it('Telegram seamless: proven off by either SDK field; on in either, or absent from both, fails', () => {
    const cfg = (seamless_auth_enabled: unknown) => ({ telegram_auth_config: { bot_id: '1', bot_name: 'b', link_enabled: false, seamless_auth_enabled } }) as Record<string, unknown>;
    expect(fails(good())).toEqual([]);
    expect(fails({ ...without('telegram_seamless_auth_enabled'), ...cfg(false) })).toEqual([]);
    expect(fails(good({ telegram_seamless_auth_enabled: true }))[0]).toMatch(/Telegram seamless login must be off/);
    expect(fails(good(cfg(true)))[0]).toMatch(/Telegram seamless login must be off/);
    expect(fails(without('telegram_seamless_auth_enabled'))[0]).toMatch(/absent from the answer/);
    expect(fails(good(cfg('false')))[0]).toMatch(/^telegram_auth_config\.seamless_auth_enabled is missing or malformed/);
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
    expect(fails(good({ telegram_seamless_auth_enabled: true }))[0]).toMatch(/Telegram seamless/);
    expect(fails(good({ external_wallets_for_signup_enabled: true }))[0]).toMatch(/external_wallets/);
    expect(fails(good({ custom_oauth_providers: [{ enabled: false, provider: 'custom:x' }] }))).toEqual([]);
  });
});

describe('the release command, exactly as RELEASE_RUNBOOK.md step 7 documents it (Codex gates F1)', () => {
  const env = { NEXT_PUBLIC_PRIVY_APP_ID: PROD, PRIVY_APP_SECRET: 'not-a-real-secret' };
  const reads = (mode: string) => async () => good({ embedded_wallet_config: { ...good().embedded_wallet_config, mode } });

  it('takes the role only: an extra argument (an attempt to pass a mode) is refused', async () => {
    expect((await runPrivyConfigCheck(['production', MODE], env, reads(MODE), MODE)).exitCode).toBe(2);
    expect((await runPrivyConfigCheck([], env, reads(MODE), MODE)).exitCode).toBe(2);
  });
  it('a different mode exits nonzero; the pinned mode passes', async () => {
    const bad = await runPrivyConfigCheck(['production'], env, reads('legacy-embedded-wallets-only'), MODE);
    expect(bad.exitCode).toBe(1);
    expect(bad.lines.at(-1)).toBe('FAIL (1)');
    const ok = await runPrivyConfigCheck(['production'], env, reads(MODE), MODE);
    expect(ok).toMatchObject({ exitCode: 0 });
    expect(ok.lines.at(-1)).toBe('PASS');
    expect(ok.lines.join('\n')).not.toContain('not-a-real-secret');
  });
  it('with the committed pin as it stands, the documented command cannot pass until the mode is pinned', async () => {
    const r = await runPrivyConfigCheck(['production'], env, reads(MODE), EXPECTED_WALLET_MODE);
    if (EXPECTED_WALLET_MODE === null) {
      expect(r.exitCode).toBe(1);
      expect(r.lines.join('\n')).toMatch(/not pinned yet/);
    } else {
      expect((await runPrivyConfigCheck(['production'], env, reads(`${EXPECTED_WALLET_MODE}-other`), EXPECTED_WALLET_MODE)).exitCode).toBe(1);
    }
  });
  it('needs the app id and secret from the shell', async () => {
    expect((await runPrivyConfigCheck(['development'], {}, reads(MODE), MODE)).exitCode).toBe(2);
  });
});
