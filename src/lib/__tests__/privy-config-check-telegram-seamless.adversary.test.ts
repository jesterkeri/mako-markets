// Adversary on 0f4e0f9 (release gates spec A): "Telegram seamless" must be off, and "any security-relevant field absent
// or of the wrong type is a FAIL, never 'off'". The installed @privy-io/node 0.35.0 AppResponse
// (resources/apps/apps.d.ts:174-175, 347-352) carries Telegram seamless login in TWO places: the optional top-level
// `telegram_seamless_auth_enabled?` and `telegram_auth_config?.seamless_auth_enabled`. The check reads only the first.
import type { AppResponse } from '@privy-io/node';
import { describe, expect, it } from 'vitest';

import { checkPrivyAppConfig, OTHER_LOGIN_METHODS, OTHER_SIGNUP_FLAGS } from '@/lib/privy-config-check';

const PROD = 'cm-prod-app-id-0000000000';
const MODE = 'user-controlled-server-wallets-only';

// Every field the gate requires, at its secure value (the same base the repo's own privy-config-check.test.ts passes).
const base: Record<string, unknown> = {
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
};

// Typed against the SDK's own AppResponse, so the name and shape are the ones Privy declares.
const seamlessOn: Pick<AppResponse, 'telegram_auth_config'> = {
  telegram_auth_config: { bot_id: '1', bot_name: 'shape_only_bot', link_enabled: false, seamless_auth_enabled: true },
};

describe('Telegram seamless login (spec A)', () => {
  it('seamless on in telegram_auth_config, the SDK-declared field, fails the gate', () => {
    // The top-level flag is present and false, so only the nested field can make this fail.
    const v = checkPrivyAppConfig({ ...base, telegram_seamless_auth_enabled: false, ...seamlessOn }, 'production', PROD, MODE);
    expect(v.ok).toBe(false);
  });

  it('Telegram seamless absent from the answer cannot be proven off, so it fails', () => {
    const v = checkPrivyAppConfig(base, 'production', PROD, MODE);
    expect(v.ok).toBe(false);
  });
});

describe('an unlisted login flag of the wrong type (spec A)', () => {
  it('a new *_auth flag reported as a non-boolean truthy value is not read as off', () => {
    for (const on of ['true', 1, { enabled: true }]) {
      const v = checkPrivyAppConfig({ ...base, telegram_seamless_auth_enabled: false, newprovider_auth: on }, 'production', PROD, MODE);
      expect(v.ok, JSON.stringify(on)).toBe(false);
    }
  });
});
